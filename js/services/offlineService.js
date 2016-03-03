'use strict';

angular.module('offlineApp').service('offlineService', function($http) {

    var view_model = this;

    /* --------------- Configuration --------------- */

    // Multistore:
    view_model.serviceDB = [

      {
          "name": "cars",
          "primaryKeyProperty": "id",
          "timestampProperty": "timestamp",
          "readURL": "http://188.166.147.80/get?after=",
          "updateURL": "http://188.166.147.80/post",
          "createURL": "http://188.166.147.80/post",
          "data": []
      },
       {
          "name": "planes",
          "primaryKeyProperty": "id",
          "timestampProperty": "timestamp",
          "readURL": "http://188.166.147.80/getBig?after=",
          "updateURL": "http://188.166.147.80/post",
          "createURL": "http://188.166.147.80/post",
          "data": []
      }
    ];

    // Default Config:
    view_model.autoSync = 0; /* Set to zero for no auto synchronisation */
    view_model.pushSync = false;
    view_model.initialSync = false;
    view_model.allowIndexedDB = true; /* Switching to false disables IndexedDB */
    view_model.allowRemote = false;

    // IndexedDB Config:
    view_model.indexedDBDatabaseName = "localDB-multi1";
    view_model.indexedDBVersionNumber = 215; /* Increment this to wipe and reset IndexedDB */
    view_model.objectStoreName = "testObjectStore";

    /* --------------- Offlinify Internals --------------- */

    // Service Variables
    view_model.idb = null;
    //view_model.serviceDB = []; /* Local image of the data */
    view_model.observerCallbacks = [];
    view_model.lastChecked = new Date("1970-01-01T00:00:00.000Z").toISOString(); /* Initially the epoch */

    // Public Functions
    view_model.subscribe = subscribe;
    view_model._generateTimestamp = _generateTimestamp;
    view_model.sync = sync;
    view_model.objectUpdate = objectUpdate;
    view_model.wipeIndexedDB = wipeIndexedDB;

    // Determine IndexedDB Support
    view_model.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB || window.shimIndexedDB;
    if(!view_model.allowIndexedDB) view_model.indexedDB = null;

    /* --------------- Create & Update --------------- */

    // Filters create or update ops by queue state:
    function objectUpdate(obj, store) {

      // Reject update if unknown objectstore is specified:
      if(_getObjStore(store) === undefined) {
        //console.log("This object store does not exist.");
        return;
      }

      _.set(obj, _getObjStore(store).timestampProperty, _generateTimestamp());
      obj = _stripAngularHashKeys(obj);

      console.log("objectUpdate object was: " + JSON.stringify(obj));

      if(obj.hasOwnProperty("syncState")) {
        if(obj.syncState > 0) { obj.syncState = 2; }
      } else {
        obj = _.cloneDeep(obj);
        obj.syncState = 0;
        _.set(obj, _getObjStore(store).primaryKeyProperty, _generateUUID());
      }
      _patchLocal(obj, store, function(response) {
        if(view_model.pushSync) sync(_notifyObservers);
      });
     };


     function _getObjStore(name) {
       return _.find( view_model.serviceDB, {"name": name} );
     };

    /* --------------- Observer Pattern --------------- */

     // Called by the controller to receive updates (observer pattern)
    function subscribe(ctrlCallback) {
       _establishIndexedDB(function() {
         view_model.observerCallbacks.push(ctrlCallback);
         if(!view_model.initialSync) return;
         view_model.sync(function(response) {
           ctrlCallback(response);
         });
       });
    };

    /* --------------- Synchronisation --------------- */

    // Restores local state on first sync, or patches local and remote changes:
    function sync(callback) {
      var startClock = _generateTimestamp();
      var newLocalRecords = _getLocalRecords(view_model.lastChecked);
      console.log("newLocalRecords was: " + newLocalRecords);
      if( newLocalRecords.length == 0 && checkServiceDBEmpty() ) {
        _restoreLocalState( function(localResponse) {
          console.log("A1.Finished restorelocalstate");
          _patchRemoteChanges(function(remoteResponse) {
            console.log("A2.Finished patchRemoteChanges");
            _reduceQueue(function(queueResponse) {
              console.log("A3.Finished _reduceQueue");
              callback( {dataSource: remoteResponse, currentQueue: queueResponse} );
              console.log("Initial load took: " + (new Date(_generateTimestamp()) - new Date(startClock))/1000 + " sec." );
              //console.log("view_model.serviceDB[0] is now: " + JSON.stringify(view_model.serviceDB[0]));
            });
          });
        });
      } else {
        console.log("Branch B");
        _patchRemoteChanges(function(remoteResponse) {
          console.log("B1. PatchRemoteChanges finshed.");
          _reduceQueue(function(queueResponse) {
            console.log("B2. ReduceQueue Finished");
            callback( { dataSource: remoteResponse, currentQueue: queueResponse } );
          });
        });
      }
    };


    function checkServiceDBEmpty() {
      var totalRecords = [];
      for(var i=0; i<view_model.serviceDB.length; i++) {
        totalRecords = totalRecords.concat(view_model.serviceDB[i].data);
      }
      if(totalRecords.length == 0) return true;
      else return false;
    };


    // Patches remote edits to serviceDB + IndexedDB:
    function _patchRemoteChanges(callback) {

      // Reject request if remote is disabled:
      if(!view_model.allowRemote) {
          if(_IDBSupported()) callback(-1);
          else callback(-2);
          return;
      }

      // If there's no data models end request:
      if(view_model.serviceDB.length == 0) {
        callback(-2); // Correct code?
        return;
      }

      var counter = 0;

      function doFunction() {
        if(view_model.serviceDB.length == counter) {
          view_model.lastChecked = _generateTimestamp();
          callback(1);
          return;
        }

        _getRemoteRecords(view_model.serviceDB[counter].readURL, function(response) {
          //console.log("In patchRemoteChanges, returned data for counter: " + counter + " was " + JSON.stringify(response));
          //console.log("view_model.lastChecked is now: " + view_model.lastChecked);
          if(response.status == 200) {
            _patchLocal(response.data, view_model.serviceDB[counter].name, function(localResponse) {
              counter++;
              doFunction();
            });
          } else {
            counter++;
            doFunction();
           }
        });
      };
      doFunction();

    };

    // Patches the local storages with a dataset.
    function _patchLocal(data, store, callback) {
      //console.log("Patch local was called, with store: " + store);
      _patchServiceDB(data, store); // DONE
      //view_model.lastChecked = _generateTimestamp();
      if( _IDBSupported() ) {
        _putArrayToIndexedDB(store, function() {
          callback(1); // Patched to IDB + ServiceDB
        });
      } else {
        callback(0); // Patched to ServiceDB only.
      }
    };

    function _notifyObservers(status) {
      angular.forEach(view_model.observerCallbacks, function(callback){
        callback(status);
      });
    };

    /* --------------- Queue + State --------------- */

    // Puts IndexedDB store into scope:
    function _restoreLocalState(callback) {
      if(!_IDBSupported()) { callback(-1); return; }
      _getIndexedDB(function(idbRecords) {

        // Collect the entire queue (?)
        var allElements = [];

        //console.log("idbRecords is: " + JSON.stringify(idbRecords));

        // For each first level (object store) element:
        for(var i=0; i<idbRecords.length; i++) {

          // Sort by newest date:
          var sortedElements = _.reverse(_.sortBy(idbRecords[i].data, function(o) {
            return new Date(_.get(o, idbRecords[i].timestampProperty)).toISOString();
          }));

          // Divide into queue/non-queue elements:
          var nonQueueElements = _.filter(idbRecords[i].data, {syncState: 1});
          var queueElements = _.filter(idbRecords[i].data, function(o) { return o.syncState != 1; });

          // Update lastChecked:
          if(nonQueueElements.length > 0) {
            var recentSyncTime = _.get(sortedElements[0], idbRecords[i].timestampProperty);
            if(recentSyncTime > view_model.lastChecked) view_model.lastChecked = recentSyncTime;

          } else {
            if(queueElements.length > 0) {
              var recentSyncTime = _.get(queueElements[queueElements.length - 1], idbRecords[i].timestampProperty);
              if(recentSyncTime > view_model.lastChecked) view_model.lastChecked = recentSyncTime;
            }
          }

        }

        // Only for TEMPORARY USE!!!!!!!!!!!!!!
        if(idbRecords.length > 0) view_model.serviceDB = idbRecords;

        //console.log("indexedDB is currently: " + JSON.stringify(idbRecords));
        //console.log("serviceDB is now: " + JSON.stringify(view_model.serviceDB));

        callback(idbRecords.length);
      });
    };

    // Synchronises elements to remote when connection is available:
    function _reduceQueue(callback) {
      if(!view_model.allowRemote) { callback(-1); return; }

      var counter = 0;

      function reduceObjectStore() {

        if(counter == view_model.serviceDB.length) {
          callback(1);
          return;
        }

        var createQueue = _.filter(view_model.serviceDB[counter].data, { "syncState" : 0 });
        var updateQueue = _.filter(view_model.serviceDB[counter].data, { "syncState" : 2 });

        console.log("createQueue was: " + JSON.stringify(createQueue));
        console.log("updateQueue was: " + JSON.stringify(updateQueue));

        // Reduce the queue:
        _safeArrayPost(createQueue, view_model.serviceDB[counter].createURL, function(successfulCreates) {
          _safeArrayPost(updateQueue, view_model.serviceDB[counter].updateURL, function(successfulUpdates) {

            var totalQueue = successfulCreates.concat(successfulUpdates);
            _.forEach(totalQueue, function(value) {
              _.set(value, view_model.serviceDB[counter].timestampProperty, _generateTimestamp());
            });

            _patchLocal(_resetSyncState(totalQueue), view_model.serviceDB[counter].name, function(response) {

              var queueLength = updateQueue.length + createQueue.length;
              var popLength = successfulCreates.length + successfulUpdates.length;

              // Check here for integrity:
              if( queueLength == popLength ) {
                // Success - all queue elements synchronised.
                counter++;
                reduceObjectStore();
              } else {
                // Partial success - some or none were synchronised.
                counter++;
                reduceObjectStore();
              }

            });
          });
        });


      }

      reduceObjectStore();


    };

    /* --------------- ServiceDB Interface --------------- */

    function _patchServiceDB(data, store) {
      console.log("Called here... ");
      var operations = _filterOperations(data, store);
      _updatesToServiceDB(operations.updateOperations, store);
      _pushToServiceDB(operations.createOperations, store);
    };

    function _pushToServiceDB(array, store) {
      //console.log("_getObjStore(store) returns: " + JSON.stringify(_getObjStore(store)));
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
      //console.log("getLocalRecords sees this serviceDB: " + JSON.stringify(view_model.serviceDB));
      var totalRecords = [];
      for(var i=0; i<view_model.serviceDB.length; i++) {
        totalRecords = totalRecords.concat( _.filter(view_model.serviceDB[i].data, function(o) {
          //console.log("i was: " + i + ", timestampProperty was: " + view_model.serviceDB[i].timestampProperty);
          //console.log("This entire object is: " + JSON.stringify(o));
          //console.log("The timestamp property was: " + _.get(o, view_model.serviceDB[i].timestampProperty));
          return new Date(_.get(o, view_model.serviceDB[i].timestampProperty)).toISOString() > sinceTime;
        }));
      }
      return totalRecords;
    };

    /* --------------- Data Handling --------------- */

    /* Filter remote data into create or update operations */
    function _filterOperations(data, store) {
      var updateOps = [];
      var createOps = [];
      for(var i=0; i<data.length; i++) {
        var queryJSON = {};
        //console.log("Store was: " + store);
        _.set(queryJSON, _getObjStore(store).primaryKeyProperty, _.get(data[i], _getObjStore(store).primaryKeyProperty));
        var query = _.findIndex(_getObjStore(store).data, queryJSON);
        if( query > -1 ) updateOps.push(data[i]);
        else createOps.push(data[i]);
      }
      return { updateOperations: updateOps, createOperations: createOps };
    }

    function _resetSyncState(records) {
      for(var i=0; i<records.length; i++) {
        records[i].syncState = 1;
      }
      return records;
    };

    /* --------------- Remote --------------- */

    function _postRemote(data, url, callback) {
      // Data should be a single record.
      $http({
          url: url,
          method: "POST",
          data: [data],
          headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
      })
      .then(
        function successCallback(response) {
          callback(response.status); // return response code.
        }, function errorCallback(response) {
          callback(response.status);
        });
    };

    function _getRemoteRecords(readURL, callback) {
      $http({
          method: 'GET',
          url: readURL + view_model.lastChecked
        })
        .then(
          function successCallback(response) {
            if(response.data.length > 0)
              callback({data: _resetSyncState(response.data), status: 200});
            else
              callback({data: [], status: 200});

        }, function errorCallback(response) {
            callback({data: [], status: response.status});
        });
    };

    // Tries to post an array one-by-one; returns successful elements.
    function _safeArrayPost(array, url, callback) {
      var x = 0;
      var successfulElements = [];
      if(array.length == 0) { callback([]); return; }
      function loopArray(array) {
        _postRemote(array[x],url,function(response) {
          if(response == 200) successfulElements.push(array[x]);
          x++;
          if(x < array.length) { loopArray(array); }
          else { callback(successfulElements); }
        });
      };
      loopArray(array);
    };

    /* --------------- IndexedDB --------------- */

    function _establishIndexedDB(callback) {
      // End request if IDB is already set-up or is not supported:
      if(!_IDBSupported() || view_model.idb) { callback(); return; }
      var request = view_model.indexedDB.open(view_model.indexedDBDatabaseName, view_model.indexedDBVersionNumber);
      request.onupgradeneeded = function(e) {
        var db = e.target.result;
        e.target.transaction.onerror = function() { console.error(this.error); };
        if(db.objectStoreNames.contains(view_model.objectStoreName)) {
          db.deleteObjectStore(view_model.objectStoreName);
        }
        var offlineItems = db.createObjectStore(view_model.objectStoreName, { keyPath: "name", autoIncrement: false } );
        //var dateIndex = offlineItems.createIndex("byDate", view_model.timestampProperty, {unique: false});
        view_model.idb = db;
      };
      request.onsuccess = function(e) {
        view_model.idb = e.target.result;
        callback();
      };
      request.onerror = function() { console.error(this.error); };
    };

    function _IDBSupported() {
      return !(view_model.indexedDB === undefined || view_model.indexedDB === null );
    };

    // Get from IndexedDB. This function returns appropriate records.
    function _getIndexedDB(callback) {
      var transaction = _newIDBTransaction();
      var objStore = transaction.objectStore(view_model.objectStoreName);
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

    // Apply array of edited objects to IndexedDB.
    function _putArrayToIndexedDB(store, callback) {

      // Reject request if no store by that name exists:
      if(_getObjStore(store) === undefined) { callback(); return; }

      // This is the IndexedDB object store, do not edit:
      var objStore = _newIDBTransaction().objectStore(view_model.objectStoreName);

      // Strip angular hash keys:
      var cleanedData = _bulkStripHashKeys(_getObjStore(store).data);
      //console.log(_getObjStore(store) + " in putArrayToIndexedDB is now: " + JSON.stringify(_getObjStore(store)));
      //console.log("Writing this to the IndexedDB: " + JSON.stringify(_getObjStore(store)));

      objStore.put(_getObjStore(store)).onsuccess = function() {
        callback();
        return;
      }

    };

    function _newIDBTransaction() {
      return view_model.idb.transaction([view_model.objectStoreName], 'readwrite');
    };

    // Only used for diagnostics:
    function wipeIndexedDB(callback) {
      var req = view_model.indexedDB.deleteDatabase(view_model.indexedDBDatabaseName);
      req.onsuccess = function(event) { callback(); }
    };

    /* --------------- Utilities --------------- */

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

    function _stripAngularHashKeys(object) {
      delete object.$$hashKey;
      return object;
    };

    function _bulkStripHashKeys(array) {
      for(var i=0; i<array.length; i++) {
        array[i] = _stripAngularHashKeys(array[i]);
      }
      return array;
    }

    /* --------------- Sync Loop -------------- */

    if(view_model.autoSync > 0 && parseInt(view_model.autoSync) === view_model.autoSync) {
      (function syncLoop() {
        setTimeout(function() {
          sync(function(response) {
            _notifyObservers(response);
          });
          syncLoop();
        }, view_model.autoSync);
      })();
    }


  });
