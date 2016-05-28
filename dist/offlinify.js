var Offlinify = (function() {

    /* --------------- Defaults --------------- */

    // Default Config:
    var autoSync = 0; /* Set to zero for no auto synchronisation */
    var pushSync = true;
    var allowIndexedDB = true; /* Switching to false disables IndexedDB */
    var allowRemote = true;
    var csrfCookieHeader = true; /* Return IDB records immediately - results in two callback calls */

    // Error Config (Response Codes):
    var retryOnResponseCodes = [401,500,502]; /* Keep item (optimistically) on queue */
    var replaceOnResponseCodes = [400,403,404]; /* Delete item from queue, try to replace */
    var maxRetry = 3; /* Try synchronising retry operations this many times */

    // IndexedDB Config:
    var indexedDBDatabaseName = "offlinifyDB-2";
    var indexedDBVersionNumber = 42; /* Increment this to wipe and reset IndexedDB */
    var objectStoreName = "offlinify-objectStore";

    /* --------------- Offlinify Internals --------------- */

    // Service Variables
    var serviceDB = [];
    var idb = null;
    var observerCallbacks = [];
    var lastChecked = new Date("1970-01-01T00:00:00.000Z").toISOString(); /* Initially the epoch */

    // Asynchronous handling
    var syncInProgress = false;
    var setupState = 0;
    var deferredFunctions = [];

    // Determine IndexedDB Support
    var indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB || window.shimIndexedDB;
    if(!allowIndexedDB) indexedDB = null;
    var contextStoreObjectStoreName = "offlinify-contextStore";

    /* --------------- Initial Configuration --------------- */

    function init(config) {
      config = config || {};
      autoSync = config.autoSync || autoSync;
      pushSync = config.pushSync || pushSync;
      allowIndexedDB = config.allowIndexedDB || allowIndexedDB;
      allowRemote = config.allowRemote || allowRemote;
      csrfCookieHeader = config.csrfCookieHeader || csrfCookieHeader;
      retryOnResponseCodes = config.retryOnResponseCodes || retryOnResponseCodes;
      replaceOnResponseCodes = config.replaceOnResponseCodes || replaceOnResponseCodes;
      maxRetry = config.maxRetry || maxRetry;
      indexedDBDatabaseName = config.indexedDBDatabaseName || indexedDBDatabaseName;

      if(setupState == 0) setupState = 1; // Support re-init
      _startSyncProcess();
    };

    function objectStore(name, primaryKeyProp, timestampProp, readURL, createURL, updateURL, readDataPrefix, postDataPrefix) {
      var newObjStore = {};
      if(name === undefined || primaryKeyProp === undefined || timestampProp === undefined || readURL === undefined || createURL === undefined) {
        console.error("Object store declaration has invalid arguments.");
        return;
      }

      if(_getObjStore(name)) { console.error("An objStore called " + name + " has already been declared."); return; }

      newObjStore.name = name;
      newObjStore.primaryKeyProperty = primaryKeyProp;
      newObjStore.timestampProperty = timestampProp;
      newObjStore.readURL = readURL;
      newObjStore.createURL = createURL;
      newObjStore.updateURL = updateURL || createURL;
      if(readDataPrefix) newObjStore.readDataPrefix = readDataPrefix;
      if(postDataPrefix) newObjStore.postDataPrefix = postDataPrefix;

      newObjStore.data = [];
      serviceDB.push(newObjStore);
    }

    /* --------------- Create/Update and Retrieve --------------- */

    // Filters create or update ops by queue state:
    function objectUpdate(obj, store, onAccept, onSync, onError) {
      _deferIfSyncing(function() {
        if(!_getObjStore(store)) { onError("Incorrect ObjectStore."); return; }
        _.set(obj, _getObjStore(store).timestampProperty, _generateTimestamp());

        if(!obj.hasOwnProperty("properties")) obj.properties = {}; // add if not existing

        if(obj.properties.hasOwnProperty("syncState")) {
          if(obj.properties.syncState > 0) { obj.properties.syncState = 2; }
        } else {
          obj = _.cloneDeep(obj);
          obj.properties.syncState = 0;
          _.set(obj, _getObjStore(store).primaryKeyProperty, _generateUUID());
        }
        obj.onSyncCallback = '(' + onSync + ')'; // Convert to string.
        obj.onErrorCallback = '(' + onError + ')';
        _patchLocal(obj, store, function(response) {
          if(pushSync) _sync(_notifyObservers);

          // Test whether object was added:
          _objectExistsInIDB(obj, store, function(response) {
            if(response !== undefined) onAccept(response);
            else onError();
          });

        });
      });
    }

    function _objectExistsInIDB(obj, store, callback) {
      _getIDB(objectStoreName, function(data) {
        var objStoreFromIDB = _.find(data, {name: store});
        if(objStoreFromIDB === undefined) { return undefined; }
        var objCandidate = _.find(objStoreFromIDB.data, function(o) {
          var idbUUID = _.get(o, objStoreFromIDB.primaryKeyProperty);
          var serviceUUID = _.get(obj, _getObjStore(store).primaryKeyProperty);
          return idbUUID == serviceUUID;
        });
        if(objCandidate !== undefined) {
           callback(objCandidate);
        }
        else {
          callback(undefined);
        }
      });
    }

    // Wraps up the data and queues the callback when required:
    function wrapData(store, callback) {
      _deferIfSyncing(function() {
        if(!_getObjStore(store)) return;
        if(_getObjStore(store).originalWrapper !== undefined) {
          var originalWrapper = _getObjStore(store).originalWrapper;
          var currentData = _getObjStore(store).data;
          _.set(originalWrapper, _getObjStore(store).readDataPrefix, currentData);
          callback(originalWrapper);
        } else {
          callback(_getObjStore(store).data);
        }
      });
    }


    /* --------------- Observer Pattern --------------- */

     // Called by a controller to be notified of data changes:
    function subscribe(ctrlCallback) {
       _establishIDB(function() {
         observerCallbacks.push(ctrlCallback);
       });
     }

    function _notifyObservers(status) {
      _.forEach(observerCallbacks, function(callback){
        callback(status);
      });
    }

    /* --------------- Synchronisation --------------- */

    function _deferIfSyncing(deferredFunction) {
      if(!syncInProgress && setupState == 2) deferredFunction();
      else { deferredFunctions.push(deferredFunction); console.warn("Defer is in progress. "); }
    }

    function _callDeferredFunctions() {
      _.forEach(deferredFunctions, function(item) { item(); });
      deferredFunctions = [];
    }

    // Restores local state on first sync, or patches local and remote changes:
    function _sync(callback) {
      console.log("_sync started.");
      if(syncInProgress) { return; } // experimental
      syncInProgress = true;
      if( _getLocalRecords(lastChecked).length == 0 && _checkServiceDBEmpty() ) {
        _restoreLocalState( function(localResponse) {
          _mergeData(callback);
        });
      } else {
        _mergeData(callback);
      }
    }

    function _mergeData(callback) {
      _patchRemoteChanges(function(remoteResponse) {
        _reduceQueue(function(queueResponse) {
          callback();
          _syncFinished();
        });
      });
    }

    function _syncFinished() {
      console.log("Sync finished.");
      setupState = 2; // finished first sync at least, guaranteed.
      _callDeferredFunctions();
      syncInProgress = false;
    }

    // Patches new changes to serviceDB + indexedDB:
    function _patchRemoteChanges(callback) {
      if( !allowRemote || serviceDB.length == 0) { callback(); return; }

      var counter = 0; // keep a count
      function checkIfFinished() {
        counter++;
        if(counter == serviceDB.length) {
          lastChecked = _generateTimestamp();
          callback();
          return;
        }
      }

      for(var i=0; i<serviceDB.length; i++) {
        _getRemoteRecords(serviceDB[i].name, i, function(response, serviceDBIndex) {
          if(response.status != 200) { checkIfFinished(); return; }

          // Check for model changes:
          _checkForModelChanges(response.data, serviceDB[serviceDBIndex].name, function(result) {

            if(result === true) {
              // data changed, so reset:
              console.log("Model change detected for objStore '" + serviceDB[serviceDBIndex].name + "', upgrading...");
              _patchRemoteChanges(callback); // call again.
              return;
            } else {
              console.log("No model change detected for objStore '" + serviceDB[serviceDBIndex].name + "'")
              _patchLocal(response.data, serviceDB[serviceDBIndex].name, function() {
                checkIfFinished();
              });
            }
          });
        });
      }

    }

    //
    function _checkForModelChanges(newData, objStoreName, callback) {
      if(newData.length == 0 || _getObjStore(objStoreName).data.length == 0) {
        callback(false);
        return; // nothing to check.
      }

      var newCandidate = newData[0];
      var newCandidateKeys = _.sortBy(_.keys(newCandidate));

      var oldCandidate = _getObjStore(objStoreName).data[0];
      var oldCandidateKeys = _.sortBy(_.keys(oldCandidate));

      if(!_.isEqual(newCandidateKeys, oldCandidateKeys)) {
        var theObjStore = _getObjStore(objStoreName);
        theObjStore.data = []; // remove data.
        _replaceIDBStore(objStoreName, function() {
          callback(true);
        });
      } else {
        callback(false);
      }

    }

    // Patches the local storages with a dataset.
    function _patchLocal(data, store, callback) {
      _patchServiceDB(data, store);
      if( _IDBSupported() ) {
        _replaceIDBStore(store, function() {
          callback(); // Patched to IDB + ServiceDB
        });
      } else {
        callback(); // Patched to ServiceDB only.
      }
    }

    /* --------------- Queue + State --------------- */

    // Puts IndexedDB store into scope:
    function _restoreLocalState(callback) {
      if(!_IDBSupported()) { callback(); return; }
      _getIDB(objectStoreName, function(idbRecords) {

        // Check for changed objStore declarations:
        var mergedIDBRecords = _upgradeObjStores(idbRecords);

        for(var i=0; i<mergedIDBRecords.length; i++) _setLastUpdated(mergedIDBRecords[i]);
        if(mergedIDBRecords.length > 0) serviceDB = mergedIDBRecords;
        callback();
      });
    }

    // Compare each loaded objStore with the current declarations:
    function _upgradeObjStores(currentIDBRecords) {

      var idbCopy = _.cloneDeep(currentIDBRecords);
      for(var i=0; i<serviceDB.length; i++) {
        var currentEquivalent = _.find(idbCopy, { name: serviceDB[i].name });

        // If an existing representation discovered in IDB then clone:
        if(currentEquivalent !== undefined) {
          var idbObjStore = _.cloneDeep(currentEquivalent);
          idbObjStore.data = serviceDB[i].data;
          delete idbObjStore.originalWrapper;

          if(!_.isEqual(idbObjStore, serviceDB[i])) {
            console.log("Updated objStore parameters detected. Upgrading store to: " + JSON.stringify(serviceDB[i]));
            _.remove(idbCopy, currentEquivalent);
            idbCopy.push(serviceDB[i]);
          }
        } else {
          idbCopy.push(serviceDB[i]); // add element to IDB if it didn't exist before.
        }

      }
      return idbCopy;
    }

    // Get last edited record from each objStore and update lastUpdated:
    function _setLastUpdated(store) {
      var sortedElements = _sortElements(store.data, store.timestampProperty);
      var elements = _separateByQueueState(store.data);
      if(elements.nonQueue.length > 0) {
        _replaceLastCheckedIfGreater(sortedElements[0], store.timestampProperty);
        return;
      }
      if(elements.queue.length > 0) {
        _replaceLastCheckedIfGreater(elements.queue[elements.queue.length -1], store.timestampProperty);
      }
    }

    // Sort elements by a given property:
    function _sortElements(records, property) {
      return _.reverse(_.sortBy(records, function(o) {
        if(_.get(o, property) == undefined) console.error("Timestamp property wasn't defined for object: " + JSON.stringify(o));
        return new Date(_.get(o, property)).toISOString();
      }));
    }

    // Divide into non-queued and queued items:
    function _separateByQueueState(records) {
      return {  nonQueue: _.filter(records, {properties: {syncState: 1}}), queue: _.filter(records, function(o) { return o.properties.syncState != 1; }) };
    }

    // Replace lastChecked if a data property has a time greater than it
    function _replaceLastCheckedIfGreater(location, property) {
      var syncedTime = _.get(location, property);
      if( syncedTime > lastChecked) lastChecked = syncedTime;
    }

    /* ------ Queue ------ */

    // Synchronises elements to remote when connection is available:
    function _reduceQueue(callback) {
      if(!allowRemote) { callback(); return; }
      var x = 0;
      (function reduceObjectStore() {
        if(x == serviceDB.length) { callback(); return; } // Return on empty queue.
        var queue = _separateCreateUpdateOperations(serviceDB[x].data);
        _safeArrayPost(queue.creates, serviceDB[x].createURL, serviceDB[x].name, function(createResponse) {
          _safeArrayPost(queue.updates, serviceDB[x].updateURL, serviceDB[x].name, function(updateResponse) {
            var itemsToPatch = _processQueueAfterRemoteResponse(createResponse, updateResponse, x);
            _patchLocal(itemsToPatch, serviceDB[x].name, function(response) {
              x++;
              reduceObjectStore();
            });
          });
        });
      })();
    }

    // Divide into create and update operation queues:
    function _separateCreateUpdateOperations(records) {
      return { creates: _.filter(records, { properties: {syncState : 0 }}), updates: _.filter(records, { properties: {syncState : 2 }}) };
    }

    function _processQueueAfterRemoteResponse(createResponse, updateResponse, objStoreID) {
      var itemsToPatch = [];

      // Collect items to retry and check/update syncstate:
      var itemsToRetry = createResponse.toRetry.concat(updateResponse.toRetry);
      var retryProcessed = _checkSyncState(itemsToRetry);
      itemsToPatch = itemsToPatch.concat(retryProcessed.survived);

      // Collect items to pop and reset timestamp:
      var itemsToPop = createResponse.toPop.concat(updateResponse.toPop);
      _.forEach(itemsToPop, function(value) { _.set(value, serviceDB[objStoreID].timestampProperty, _generateTimestamp()); });
      itemsToPatch = itemsToPatch.concat(_resetSyncState(itemsToPop));

      // Collect items to replace:
      var itemsToReplace = createResponse.toReplace.concat(updateResponse.toReplace);
      itemsToReplace = itemsToReplace.concat(retryProcessed.toReplace); // add max retried elements
      itemsToPatch = itemsToPatch.concat(_replaceQueue(serviceDB[objStoreID].name, itemsToReplace));

      return itemsToPatch;
    }

    // Update the syncState value for retry-able elements:
    function _checkSyncState(elementsToRetry) {
      var survived = [];
      var toReplace = [];
      _.forEach(elementsToRetry, function(item) {
        if(item.syncAttempts === undefined) item.syncAttempts = 1;
        else item.syncAttempts = item.syncAttempts + 1;
        if(item.syncAttempts > maxRetry) toReplace.push(item);
        else survived.push(item);
      });
      return({"survived": survived, "toReplace": toReplace});
    }

    // Set elements to the epoch to force it to be replaced:
    function _replaceQueue(store, elementsToReplace) {
      _.forEach(elementsToReplace, function(item) {
        _.set(item, _getObjStore(store).timestampProperty, "1971-01-01T00:00:00.000Z");
      });
      return elementsToReplace;
    }

    /* --------------- ServiceDB Interface --------------- */

    function _checkServiceDBEmpty() {
      var totalRecords = [];
      for(var i=0; i<serviceDB.length; i++) {
        totalRecords = totalRecords.concat(serviceDB[i].data);
      }
      if(totalRecords.length == 0) return true;
      else return false;
    }

    function _getObjStore(name) {
      return _.find( serviceDB, {"name": name} ) || false;
    }

    function _patchServiceDB(data, store) {
      var operations = _filterOperations(data, store);
      _updatesToServiceDB(operations.updateOperations, store);
      _pushToServiceDB(operations.createOperations, store);
    }

    function _pushToServiceDB(array, store) {
      for(var i=0; i<array.length; i++) _getObjStore(store).data.push(array[i]);
    }

    function _updatesToServiceDB(array, store) {
      for(var i=0; i<array.length; i++) {
        var indexJSON = {};
        _.set(indexJSON, _getObjStore(store).primaryKeyProperty, _.get(array[i], _getObjStore(store).primaryKeyProperty));
        var matchID = _.findIndex(_getObjStore(store).data, indexJSON);
        if(matchID > -1) _getObjStore(store).data[matchID] = array[i];
      }
    }

    function _getLocalRecords(sinceTime) {
      var totalRecords = [];
      for(var i=0; i<serviceDB.length; i++) {
        totalRecords = totalRecords.concat( _.filter(serviceDB[i].data, function(o) {
          try{
            return new Date(_.get(o, serviceDB[i].timestampProperty)).toISOString() > sinceTime;
          } catch(err) {
            console.error("There's an object with an invalid timestamp property: " + JSON.stringify(o));
          }
        }));
      }
      return totalRecords;
    }

    /* --------------- Data Handling --------------- */

    /* Filter remote data into create or update operations */
    function _filterOperations(data, store) {
      var updateOps = [];
      var createOps = [];
      if(data.constructor !== Array) data = [data];
      for(var i=0; i<data.length; i++) {
        var queryJSON = {};
        _.set(queryJSON, _getObjStore(store).primaryKeyProperty, _.get(data[i], _getObjStore(store).primaryKeyProperty));
        var query = _.findIndex(_getObjStore(store).data, queryJSON);
        if( query > -1 ) updateOps.push(data[i]);
        else createOps.push(data[i]);
      }
      return { updateOperations: updateOps, createOperations: createOps };
    }

    function _resetSyncState(records) {
      for(var i=0; i<records.length; i++) records[i].properties.syncState = 1;
      return records;
    }

    /* --------------- Remote --------------- */

    function _getRemoteRecords(store, originalIndex, callback) {
      _receiveData(_getObjStore(store).readURL + lastChecked, function(response) {
        if(response.data != [] && response.response > 0) {
          if(typeof response.data !== 'object') response.data = JSON.parse(response.data);
          // Unprefix data:
          if(_getObjStore(store).readDataPrefix !== undefined) {
            var unwrappedData = _unwrapData(response.data, store);
            callback({data: _resetSyncState(unwrappedData), status: 200}, originalIndex);
          } else {
            callback({data: _resetSyncState(response.data), status: 200}, originalIndex);
          }
        } else {
          callback({data: [], status: response.response}, originalIndex);
        }
      });
    }

    // Tries to post an array one-by-one; returns successful elements.
    function _safeArrayPost(array, url, objStoreName, callback) {
      var x = 0;
      var toPop = [];
      var toRetry = [];
      var toReplace = [];
      var noChange = [];

      if(array.length == 0) { callback({"toPop": [], "toRetry": [], "toReplace": [], "noChange": []}); return; }
      (function loopArray() {
        _sendData(array[x],url,objStoreName,function(response) {
          if(x >= array.length) return;

          if(response == 200) {
            toPop.push(array[x]);
            if(array[x].onSyncCallback) {
              console.log("Object synchronised with the server.");
              var syncCallback = eval(array[x].onSyncCallback);
              syncCallback(array[x]);
            }
          } else if(response == 0) {
            noChange.push(array[x]);
          } else {
            if(_.find(retryOnResponseCodes, response) !== undefined) {
              toRetry.push(array[x]);
            } else if(_.find(replaceOnResponseCodes, response) !== undefined) {
              toReplace.push(array[x]);
              if(array[x].onErrorCallback) {
                var errCallback = eval(array[x].onErrorCallback);
                errCallback(response); // Return entire response
              }
            } else {
              toRetry.push(array[x]); // Retry on unknown code.
            }
          }

          x++;
          if(x < array.length) { loopArray(); }
          else { callback({"toPop": toPop, "toRetry": toRetry, "toReplace": toReplace, "noChange": noChange}); }
        });
      })();
    }

    /* --------------- IndexedDB --------------- */

    function _IDBSupported() {
      return !( indexedDB === undefined || indexedDB === null );
    }

    function _establishIDB(callback) {
      if(!_IDBSupported() || idb) { callback(); return; } // End if no support or disabled
      var request = indexedDB.open(indexedDBDatabaseName, indexedDBVersionNumber);
      request.onupgradeneeded = function(e) {
        var db = e.target.result;
        e.target.transaction.onerror = function() { console.error(this.error); };
        if(db.objectStoreNames.contains(objectStoreName)) {
          db.deleteObjectStore(objectStoreName);
        }
        if(db.objectStoreNames.contains(contextStoreObjectStoreName)) {
          db.deleteObjectStore(contextStoreObjectStoreName);
        }
        var offlineItems = db.createObjectStore(objectStoreName, { keyPath: "name", autoIncrement: false } );
        var contextStore = db.createObjectStore(contextStoreObjectStoreName, {keyPath: "key", autoIncrement: false });
        //var dateIndex = offlineItems.createIndex("byDate", timestampProperty, {unique: false});
        idb = db;
      };
      request.onsuccess = function(e) {
        idb = e.target.result;
        callback();
      };
      request.onerror = function() { console.error(this.error); };
    }

    // Get the entire IndexedDB image:
    function _getIDB(storeName, callback) {
      var transaction = _newIDBTransaction(storeName);
      var objStore = transaction.objectStore(storeName);
      var keyRange = IDBKeyRange.lowerBound(0);
      //var cursorRequest = objStore.index('byDate').openCursor(keyRange);
      var cursorRequest = objStore.openCursor(keyRange);
      var returnableItems = [];
      transaction.oncomplete = function(e) {
        callback(_bulkStripHashKeys(returnableItems));
      };
      cursorRequest.onsuccess = function(e) {
        var result = e.target.result;
        if (!!result == false) { return; }
        returnableItems.push(result.value);
        result.continue();
      };
      cursorRequest.onerror = function() { console.error("error"); };
    }

    // Replaces an older IDB store with a new local one:
    function _replaceIDBStore(store, callback) {
      if(!_getObjStore(store)) { callback(); return; }
      _bulkStripHashKeys(_getObjStore(store).data); // Strip Angular-like hashkeys
      var objStore = _newIDBTransaction(objectStoreName).objectStore(objectStoreName);
      var theNewObjStore = _.cloneDeep(_getObjStore(store));
      theNewObjStore.data = JSON.parse(JSON.stringify(theNewObjStore.data)); // Ensure serialisation
      objStore.put(theNewObjStore).onsuccess = function() {
        callback();
        return;
      }
    }

    function _newIDBTransaction(storeName) {
      return idb.transaction([storeName], 'readwrite');
    }

    /* --------------- Utilities --------------- */

    function _unwrapData(data, store) {
      var objStore = _getObjStore(store);
      var nestedData = _.get(data, _getObjStore(store).readDataPrefix) || []; // handle empty data.
      objStore.originalWrapper = data;
      _.set(objStore.originalWrapper, objStore.readDataPrefix, []);
      return nestedData;
    }

    function _generateTimestamp() {
      var d = new Date();
      return d.toISOString();
    }

    // (v4) With thanks to http://stackoverflow.com/a/8809472/3381433
    function _generateUUID() {
      var d = new Date().getTime();
      if(window.performance && typeof window.performance.now === "function"){
          d += performance.now(); // use high-precision timer if available
      }
      var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          var r = (d + Math.random()*16)%16 | 0;
          d = Math.floor(d/16);
          return (c=='x' ? r : (r&0x3|0x8)).toString(16);
      });
      return uuid;
    }

    function _bulkStripHashKeys(array) {
      for(var i=0; i<array.length; i++) {
        delete array[i].$$hashKey;
      }
      return array;
    }

    function wipe() {
      _deferIfSyncing(wipeImmediately);
    }

    function wipeImmediately() {
      indexedDB.deleteDatabase(indexedDBDatabaseName);
      serviceDB = [];
      console.warn("Database wiped.");
    }

    /* --------------- ContextStore API --------------- */

    // Find saved object in IDB with a key:
    function getContext(key, callback) {
      _deferIfSyncing(function() {
        _getIDB(contextStoreObjectStoreName, function(data) {
          callback(_.find(data, {"key": key}));
        });
      }
      );
    }

    // Save object in IDB using a valid key:
    function saveContext(contextObject, callback) {
      _deferIfSyncing(function() {
        var objStore = _newIDBTransaction(contextStoreObjectStoreName).objectStore(contextStoreObjectStoreName);
        objStore.put(contextObject).onsuccess = function() {
          callback();
            return;
          }
        }
      );
    }

    /* --------------- Diagnostics --------------- */

    // Returns only the specifications of each objStore
    function objStoreMap() {
      var objStoreMap = _.cloneDeep(serviceDB);
      _.forEach(objStoreMap, function(objStore) {
        objStore.data = [];
      });
      return objStoreMap;
    }

    /* --------------- $http re-implementation --------------- */

    function _receiveData(url, callback) {
      var request = new XMLHttpRequest();
      request.open('GET', url, true);
      request.onload = function() {
        if (request.status >= 200 && request.status < 400) {
          callback({ response: request.status, data: request.response }); // 2xx - 3xx response:
        } else {
          callback({ response: request.status, data: [] }); // 4xx - 5xx response:
        }
      }
      request.onerror = function() {
        callback({ response: 0, data: [] }); // Server unreachable:
      };
      request.send();
    }

    function _sendData(data, url, objStoreName, callback) {
      if(_getObjStore(objStoreName).postDataPrefix !== undefined) {
        var prefix = _getObjStore(objStoreName).postDataPrefix;
        var tempData = _.cloneDeep(data);
        var tempObj = {};
        data = [];
        tempObj[prefix] = JSON.stringify(tempData); // experimental
        data = tempObj;
      }

      var request = new XMLHttpRequest();
      request.open('POST', url, true);
      request.setRequestHeader("Content-Type", "application/json;charset=UTF-8");

      /* Get the CSRF token */
      if(csrfCookieHeader) {
        var reg = new RegExp("xcsrfcookie=([^;]+)");
        var value = reg.exec(document.cookie);
        request.setRequestHeader("X-CSRFToken", value[0].replace('xcsrfcookie=', ''));
      }

      request.send(JSON.stringify(data));
      request.onreadystatechange = function() {
        callback(request.status); // Return status and defer logic until later
      }
      request.onerror = function() {
        console.log("A connection error was received for: " + url);
        callback({response: 0, data: [] });
      }
    }


    /* --------------- Sync Loop -------------- */

    // Called by config to denote end of setup:
    function _startSyncProcess() {
      _establishIDB(function() {
        (function syncLoop() {
          setTimeout(function() {
            _sync(function(response) {
              _notifyObservers(response);
            });
            if(autoSync > 0 && parseInt(autoSync) === autoSync) syncLoop();
          }, autoSync);
        })();
      });
    }

    /* --------------- Method Exposure --------------- */

    return {
      objectUpdate: objectUpdate,
      wrapData: wrapData,
      subscribe: subscribe,
      init: init,
      objectStore: objectStore,
      objStoreMap: objStoreMap,
      wipe: wipe,
      wipeImmediately: wipeImmediately,
      getContext: getContext,
      saveContext: saveContext
    }

  }());
