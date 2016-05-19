'use strict';

var Offlinify = (function() {

    /* --------------- Defaults --------------- */

    // Default Config:
    var autoSync = 0; /* Set to zero for no auto synchronisation */
    var pushSync = true;
    var allowIndexedDB = true; /* Switching to false disables IndexedDB */
    var allowRemote = true;
    var earlyDataReturn = false; /* Return IDB records immediately - results in two callback calls */

    // Error Config (Response Codes):
    var retryOnResponseCodes = [401,500,502]; /* Keep item (optimistically) on queue */
    var replaceOnResponseCodes = [400,403,404]; /* Delete item from queue, try to replace */
    var maxRetry = 3; /* Try synchronising retry operations this many times */

    // IndexedDB Config:
    var indexedDBDatabaseName = "offlinifyDB-2";
    var indexedDBVersionNumber = 40; /* Increment this to wipe and reset IndexedDB */
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

    /* --------------- Initial Configuration --------------- */

    function init(config) {
      config = config || {};
      autoSync = config.autoSync || autoSync;
      pushSync = config.pushSync || pushSync;
      allowIndexedDB = config.allowIndexedDB || allowIndexedDB;
      allowRemote = config.allowRemote || allowRemote;
      earlyDataReturn = config.earlyDataReturn || earlyDataReturn;
      retryOnResponseCodes = config.retryOnResponseCodes || retryOnResponseCodes;
      replaceOnResponseCodes = config.replaceOnResponseCodes || replaceOnResponseCodes;
      maxRetry = config.maxRetry || maxRetry;
      indexedDBDatabaseName = config.indexedDBDatabaseName || indexedDBDatabaseName;

      if(setupState == 0) setupState = 1; // Support re-init
      startSyncProcess();
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
    };

    /* --------------- Create/Update and Retrieve --------------- */

    // Filters create or update ops by queue state:
    function objectUpdate(obj, store, onAccept, onSync, onError) {
      deferIfSyncing(function() {
        if(!checkIfObjectStoreExists(store)) { onError("Incorrect ObjectStore."); return; }
        _.set(obj, _getObjStore(store).timestampProperty, _generateTimestamp());
        if(obj.hasOwnProperty("syncState")) {
          if(obj.syncState > 0) { obj.syncState = 2; }
        } else {
          obj = _.cloneDeep(obj);
          obj.syncState = 0;
          _.set(obj, _getObjStore(store).primaryKeyProperty, _generateUUID());
        }
        obj.onSyncCallback = '(' + onSync + ')'; // Convert to string.
        obj.onErrorCallback = '(' + onError + ')';
        _patchLocal(obj, store, function(response) {
          if(pushSync) sync(_notifyObservers);

          // Test whether object was added:
          objectExistsInIDB(obj, store, function(response) {
            if(response !== undefined) onAccept(response);
            else onError();
          });

        });
      });
    };

    function objectExistsInIDB(obj, store, callback) {
      _getIDB(function(data) {
        console.log("objectExistsInIDB called.");
        var objStoreFromIDB = _.find(data, {name: store});
        if(objStoreFromIDB === undefined) { return undefined; }
        var objCandidate = _.find(objStoreFromIDB.data, function(o) {
          var idbUUID = _.get(o, objStoreFromIDB.primaryKeyProperty);
          var serviceUUID = _.get(obj, _getObjStore(store).primaryKeyProperty);
          return idbUUID == serviceUUID;
        });
        console.log("objCandidate was: " + JSON.stringify(objCandidate));
        if(objCandidate !== undefined) {
          console.log("returning objCandidate");
           callback(objCandidate);
        }
        else {
          console.log("returning undefined");
          callback(undefined);
        }
      });
    }

    // Wraps up the data and queues the callback when required:
    function wrapData(store, callback) {
      deferIfSyncing(function() {
        if(!checkIfObjectStoreExists(store)) return;
        if(_getObjStore(store).originalWrapper !== undefined) {
          var originalWrapper = _getObjStore(store).originalWrapper;
          //console.log("originalWrapper, before data manipulation, was: " + JSON.stringify(originalWrapper));
          var currentData = _getObjStore(store).data;
          _.set(originalWrapper, _getObjStore(store).readDataPrefix, currentData);
          //console.log("the originalWrapper being sent back is: " + JSON.stringify(originalWrapper));
          //console.log("the currentData in wrapData was: " + JSON.stringify(currentData));
          callback(originalWrapper);
        } else {
          callback(_getObjStore(store).data);
        }
      });
    };

    function checkIfObjectStoreExists(storeName) {
      if(!_getObjStore(storeName)) {
        console.error("objStore '" + storeName + "' does not exist.");
        return false;
      }
      return true;
    };

    /* --------------- Observer Pattern --------------- */

     // Called by a controller to be notified of data changes:
    function subscribe(ctrlCallback) {
       _establishIDB(function() {
         observerCallbacks.push(ctrlCallback);
       });
     };

    function _notifyObservers(status) {
      _.forEach(observerCallbacks, function(callback){
        callback(status);
      });
    };

    /* --------------- Synchronisation --------------- */

    function deferIfSyncing(deferredFunction) {
      if(!syncInProgress && setupState == 2) deferredFunction();
      else {deferredFunctions.push(deferredFunction); console.warn("Defer is in progress. "); }
    };

    function callDeferredFunctions() {
      _.forEach(deferredFunctions, function(item) { item(); });
      deferredFunctions = [];
    };

    // Restores local state on first sync, or patches local and remote changes:
    function sync(callback) {
      console.log("Sync started.");
      if(syncInProgress) { return; } // experimental
      syncInProgress = true;
      if( _getLocalRecords(lastChecked).length == 0 && checkServiceDBEmpty() ) {
        _restoreLocalState( function(localResponse) {
          if(earlyDataReturn) callback(); // Load IDB records straight into DOM first.
          mergeData(callback);
        });
      } else {
        mergeData(callback);
      }
    };

    function mergeData(callback) {
      _patchRemoteChanges(function(remoteResponse) {
        _reduceQueue(function(queueResponse) {
          callback();
          syncFinished();
        });
      });
    };

    function syncFinished() {
      console.log("Sync finished.");
      setupState = 2; // finished first sync at least, guaranteed.
      callDeferredFunctions();
      syncInProgress = false;
    };

    // Patches new changes to serviceDB + indexedDB:
    function _patchRemoteChanges(callback) {

      if( !allowRemote || serviceDB.length == 0) { callback(); return; }

      var counter = 0;

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
            _patchLocal(response.data, serviceDB[serviceDBIndex].name, function() {
              checkIfFinished();
            })
          });
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
    };

    /* --------------- Queue + State --------------- */

    // Puts IndexedDB store into scope:
    function _restoreLocalState(callback) {
      if(!_IDBSupported()) { callback(); return; }
      _getIDB(function(idbRecords) {
        // <--- Do objStore-based upgrading here --->
        // Update lastUpdated using each object store:
        for(var i=0; i<idbRecords.length; i++) _setLastUpdated(idbRecords[i]);
        if(idbRecords.length > 0) serviceDB = idbRecords;
        callback();
      });
    };

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
    };

    // Sort elements by a given property:
    function _sortElements(records, property) {
      return _.reverse(_.sortBy(records, function(o) {
        if(_.get(o, property) == undefined) console.error("Timestamp property wasn't defined for object: " + JSON.stringify(o));
        return new Date(_.get(o, property)).toISOString();
      }));
    }

    // Divide into non-queued and queued items:
    function _separateByQueueState(records) {
      return {  nonQueue: _.filter(records, {syncState: 1}), queue: _.filter(records, function(o) { return o.syncState != 1; }) };
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
    };

    // Divide into create and update operation queues:
    function _separateCreateUpdateOperations(records) {
      return { creates: _.filter(records, { "syncState" : 0 }), updates: _.filter(records, { "syncState" : 2 }) };
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
    };

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
    };

    // Set elements to the epoch to force it to be replaced:
    function _replaceQueue(store, elementsToReplace) {
      _.forEach(elementsToReplace, function(item) {
        _.set(item, _getObjStore(store).timestampProperty, "1971-01-01T00:00:00.000Z");
      });
      return elementsToReplace;
    };

    /* --------------- ServiceDB Interface --------------- */

    function checkServiceDBEmpty() {
      var totalRecords = [];
      for(var i=0; i<serviceDB.length; i++) {
        totalRecords = totalRecords.concat(serviceDB[i].data);
      }
      if(totalRecords.length == 0) return true;
      else return false;
    };

    function _getObjStore(name) {
      return _.find( serviceDB, {"name": name} ) || false;
    };

    function _patchServiceDB(data, store) {
      var operations = _filterOperations(data, store);
      _updatesToServiceDB(operations.updateOperations, store);
      _pushToServiceDB(operations.createOperations, store);
    };

    function _pushToServiceDB(array, store) {
      for(var i=0; i<array.length; i++) _getObjStore(store).data.push(array[i]);
    };

    function _updatesToServiceDB(array, store) {
      for(var i=0; i<array.length; i++) {
        var indexJSON = {};
        _.set(indexJSON, _getObjStore(store).primaryKeyProperty, _.get(array[i], _getObjStore(store).primaryKeyProperty));
        var matchID = _.findIndex(_getObjStore(store).data, indexJSON);
        if(matchID > -1) _getObjStore(store).data[matchID] = array[i];
      }
    };

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
    };

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
      for(var i=0; i<records.length; i++) records[i].syncState = 1;
      return records;
    };

    /* --------------- Remote --------------- */

    function _getRemoteRecords(store, originalIndex, callback) {
      receiveData(_getObjStore(store).readURL + lastChecked, function(response) {
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
    };

    // Tries to post an array one-by-one; returns successful elements.
    function _safeArrayPost(array, url, objStoreName, callback) {
      var x = 0;
      var toPop = [];
      var toRetry = [];
      var toReplace = [];
      var noChange = [];

      if(array.length == 0) { callback({"toPop": [], "toRetry": [], "toReplace": [], "noChange": []}); return; }
      (function loopArray() {
        sendData(array[x],url,objStoreName,function(response) {
          if(x >= array.length) return;

          console.log("THe response was: " + response);

          if(response == 200) {
            toPop.push(array[x]);
            if(array[x].onSyncCallback) {
              console.log("This object would have synchronised!!!!!!!!");
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
              toRetry.push(array[x]); // for now, retry on unknown code.
            }
          }

          x++;
          if(x < array.length) { loopArray(); }
          else { callback({"toPop": toPop, "toRetry": toRetry, "toReplace": toReplace, "noChange": noChange}); }
        });
      })();
    };

    /* --------------- IndexedDB --------------- */

    function _IDBSupported() {
      return !( indexedDB === undefined || indexedDB === null );
    };

    function _establishIDB(callback) {
      if(!_IDBSupported() || idb) { callback(); return; } // End if no support or disabled
      var request = indexedDB.open(indexedDBDatabaseName, indexedDBVersionNumber);
      request.onupgradeneeded = function(e) {
        var db = e.target.result;
        e.target.transaction.onerror = function() { console.error(this.error); };
        if(db.objectStoreNames.contains(objectStoreName)) {
          db.deleteObjectStore(objectStoreName);
        }
        var offlineItems = db.createObjectStore(objectStoreName, { keyPath: "name", autoIncrement: false } );
        //var dateIndex = offlineItems.createIndex("byDate", timestampProperty, {unique: false});
        idb = db;
      };
      request.onsuccess = function(e) {
        idb = e.target.result;
        callback();
      };
      request.onerror = function() { console.error(this.error); };
    };

    // Get the entire IndexedDB image:
    function _getIDB(callback) {
      var transaction = _newIDBTransaction();
      var objStore = transaction.objectStore(objectStoreName);
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
    };

    // Replaces an older IDB store with a new local one:
    function _replaceIDBStore(store, callback) {
      // Reject request if no store by that name exists:
      if(!checkIfObjectStoreExists(store)) { callback(); return; }
      _bulkStripHashKeys(_getObjStore(store).data); // Strip Angular-like hashkeys
      var objStore = _newIDBTransaction().objectStore(objectStoreName);
      var theNewObjStore = _.cloneDeep(_getObjStore(store));
      //console.log(theNewObjStore);
      //var theNewObjStore = JSON.parse(JSON.stringify(_getObjStore(store)));
      theNewObjStore.data = JSON.parse(JSON.stringify(theNewObjStore.data)); /* This makes it work... */
      objStore.put(theNewObjStore).onsuccess = function() {
        callback();
        return;
      }
    };

    function _newIDBTransaction() {
      return idb.transaction([objectStoreName], 'readwrite');
    };

    /* --------------- Utilities --------------- */

    function _unwrapData(data, store) {
      var objStore = _getObjStore(store);
      var nestedData = _.get(data, _getObjStore(store).readDataPrefix) || []; // handle empty data. - this returns undefined on no remote connection
      objStore.originalWrapper = data;
      _.set(objStore.originalWrapper, objStore.readDataPrefix, []);
      return nestedData;
    };

    function _generateTimestamp() {
      var d = new Date();
      return d.toISOString();
    };

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
    };

    function _bulkStripHashKeys(array) {
      for(var i=0; i<array.length; i++) {
        delete array[i].$$hashKey;
      }
      return array;
    };

    function wipe() {
      deferIfSyncing(wipeImmediately);
    }

    function wipeImmediately() {
      indexedDB.deleteDatabase(indexedDBDatabaseName);
      serviceDB = [];
      console.warn("Database wiped.");
    };

    /* --------------- Diagnostics --------------- */

    // Returns only the specifications of each objStore
    function objStoreMap() {
      var objStoreMap = _.cloneDeep(serviceDB);
      _.forEach(objStoreMap, function(objStore) {
        objStore.data = [];
      });
      return objStoreMap;
    };

    /* --------------- $http re-implementation --------------- */

    function receiveData(url, callback) {
      var request = new XMLHttpRequest();
      request.open('GET', url, true);
      request.onload = function() {
        if (request.status >= 200 && request.status < 400) {
          // 2xx - 3xx response:
          console.log("in receiveData, the request.status was: " + request.status);
          callback({ response: request.status, data: request.response });
        } else {
          // 4xx - 5xx response:
          console.log("Target server returned a " + request.status + " error");
          callback({ response: request.status, data: [] });
        }
      };

      // Server unreachable:
      request.onerror = function() {
        console.log("A connection error was received for: " + url);
        callback({ response: 0, data: [] });
      };

      request.send();
    };

    function sendData(data, url, objStoreName, callback) {
      console.log("Send data function was called.");
      console.log("document.cookie is: " + document.cookie.replace('xcsrfcookie=', ''));

      if(_getObjStore(objStoreName).postDataPrefix !== undefined) {
        var prefix = _getObjStore(objStoreName).postDataPrefix;
        var tempData = _.cloneDeep(data);
        var tempObj = {};
        //console.log("data was: " + JSON.stringify(tempObj));
        data = [];
        tempObj[prefix] = JSON.stringify(tempData); // EXPERIMENTAL!!!!!!!!!!!!!
        //console.log("New data with prefix through sendData is: " + JSON.stringify(tempObj));
        data = tempObj;
      }

      var request = new XMLHttpRequest();
      request.open('POST', url, true);
      request.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
      request.setRequestHeader("X-CSRFToken", document.cookie.replace('xcsrfcookie=', ''));
      console.log("Being sent to the server: " + JSON.stringify(data));
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
    function startSyncProcess() {
      _establishIDB(function() {
        (function syncLoop() {
          setTimeout(function() {
            sync(function(response) {
              _notifyObservers(response);
            });
            if(autoSync > 0 && parseInt(autoSync) === autoSync) syncLoop();
          }, autoSync);
        })();
      });
    };

    /* --------------- Method Exposure --------------- */

    return {
      objectUpdate: objectUpdate,
      wrapData: wrapData,
      subscribe: subscribe,
      init: init,
      objectStore: objectStore,
      objStoreMap: objStoreMap,
      wipe: wipe,
      wipeImmediately: wipeImmediately
    }

  }());
