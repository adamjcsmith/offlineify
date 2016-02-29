'use strict';

angular.module('offlineApp').service('offlineService', function($http) {

    var view_model = this;

    /* --------------- Configuration --------------- */

    // API Parameters
    view_model.readAPI = "http://188.166.147.80/get?after=";
    view_model.updateAPI = "http://188.166.147.80/post";
    view_model.createAPI = "http://188.166.147.80/post";
    view_model.primaryKeyProperty = "id";
    view_model.timestampProperty = "timestamp";

    // Default Config:
    view_model.autoSync = 10000; /* Set to zero for no auto synchronisation */
    view_model.pushSync = false;
    view_model.initialSync = true;
    view_model.allowIndexedDB = true; /* Switching to false disables IndexedDB */
    view_model.allowRemote = true;

    // IndexedDB Config:
    view_model.indexedDBDatabaseName = "localDB-2";
    view_model.indexedDBVersionNumber = 177; /* Increment this to wipe and reset IndexedDB */
    view_model.objectStoreName = "testObjectStore";

    /* --------------- Offlinify Internals --------------- */

    // Service Variables
    view_model.idb = null;
    view_model.serviceDB = []; /* Local image of the data */
    view_model.observerCallbacks = [];
    view_model.lastChecked = new Date("1970-01-01T00:00:00.000Z").toISOString(); /* Initially the epoch */

    // Public Functions
    view_model.registerController = registerController;
    view_model._generateTimestamp = _generateTimestamp;
    view_model.sync = sync;
    view_model.objectUpdate = objectUpdate;
    view_model.wipeIndexedDB = wipeIndexedDB;

    // Determine IndexedDB Support
    view_model.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB || window.shimIndexedDB;
    if(!view_model.allowIndexedDB) view_model.indexedDB = null;

    /* --------------- Create & Update --------------- */

    // Filters create or update ops by queue state:
    function objectUpdate(obj) {
      _.set(obj, view_model.timestampProperty, _generateTimestamp());
      obj = _stripAngularHashKeys(obj);
      if(obj.hasOwnProperty("syncState")) {
        if(obj.syncState > 0) { obj.syncState = 2; }
      } else {
        obj = _.cloneDeep(obj);
        obj.syncState = 0;
        _.set(obj, view_model.primaryKeyProperty, _generateUUID());
      }
      _patchLocal(_stripAngularHashKeys([obj]), function(response) {
        if(view_model.pushSync) sync(_notifyObservers);
      });
     };

     /* --------------- Observer Pattern --------------- */

     // Called by the controller to receive updates (observer pattern)
    function registerController(ctrlCallback) {
       ensureIDBReady(function() {
         view_model.observerCallbacks.push(ctrlCallback);
         if(!view_model.initialSync) return;
         view_model.sync(function(response) {
           ctrlCallback(response);
         });
       });
     };

     function ensureIDBReady(callback) {
        if(view_model.idb == null)
          _establishIndexedDB(function() { callback(); });
        else
          callback();
     };

    /* --------------- Synchronisation --------------- */

    // Restores local state on first sync, or patches local and remote changes:
    function sync(callback) {
      var startClock = _generateTimestamp();
      var newLocalRecords = _getLocalRecords(view_model.lastChecked);
      if( newLocalRecords.length == 0 && view_model.serviceDB.length == 0 ) {
        _restoreLocalState( function(localResponse) {
          _patchRemoteChanges(function(remoteResponse) {
            _reduceQueue(function(queueResponse) {
              callback( {dataSource: remoteResponse, currentQueue: queueResponse} );
              console.log("Initial load took: " + (new Date(_generateTimestamp()) - new Date(startClock))/1000 + " sec." );
            });
          });
        });
      } else {
        _patchRemoteChanges(function(remoteResponse) {
          _reduceQueue(function(queueResponse) {
            callback( { dataSource: remoteResponse, currentQueue: queueResponse } );
          });
        });
      }
    };

    // Patches remote edits to serviceDB + IndexedDB:
    function _patchRemoteChanges(callback) {
      if(!view_model.allowRemote) {
          if(_hasIndexedDB()) callback(-1);
          else callback(-2);
          return;
      }
      _getRemoteRecords(function(response) {
        if(response.status == 200) {
          _patchLocal(response.data, function(localResponse) {
            callback(localResponse);
          });
        } else { callback("Could not connect to remote server: (" + response.status + ") error."); }
      });
    };

    // Patches the local storages with a dataset.
    function _patchLocal(data, callback) {
      _patchServiceDB(data);
      view_model.lastChecked = _generateTimestamp();
      if( _hasIndexedDB() ) {
        _putArrayToIndexedDB(data, function() {
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
      if(!_hasIndexedDB()) { callback(-1); return; }
      _getIndexedDB(function(idbRecords) {

        var sortedElements = _.reverse(_.sortBy(idbRecords, function(o) {
          return new Date(_.get(o, view_model.timestampProperty)).toISOString();
        }));
        var nonQueueElements = _.filter(sortedElements, {syncState: 1});
        var queueElements = _.filter(sortedElements, function(o) { return o.syncState != 1; });

        if(nonQueueElements.length > 0) {
          view_model.lastChecked = _.get(sortedElements[0], view_model.timestampProperty);
        } else {
          if(queueElements.length > 0)
            view_model.lastChecked = _.get(queueElements[queueElements.length - 1], view_model.timestampProperty);
        }

        _patchServiceDB(idbRecords);
        callback(idbRecords.length);
      });
    };

    // Synchronises elements to remote when connection is available:
    function _reduceQueue(callback) {
      if(!view_model.allowRemote) { callback(-1); return; }

      var createQueue = _.filter(view_model.serviceDB, { "syncState" : 0 });
      var updateQueue = _.filter(view_model.serviceDB, { "syncState" : 2 });

      // Get rid of the create queue:
      _safeArrayPost(createQueue, view_model.createAPI, function(successfulCreates) {
        _safeArrayPost(updateQueue, view_model.updateAPI, function(successfulUpdates) {

          var totalQueue = successfulCreates.concat(successfulUpdates);
          _.forEach(totalQueue, function(value) {
            _.set(value, view_model.timestampProperty, _generateTimestamp());
          });

          _patchLocal(_resetSyncState(totalQueue), function(response) {

            var queueLength = updateQueue.length + createQueue.length;
            var popLength = successfulCreates.length + successfulUpdates.length;

            // Check here for integrity:
            if( queueLength == popLength ) {
              callback(1); // Success: All queue elements synchronised.
            } else {
              callback(0); // Partial success: Some or none were synchronised.
            }

          });
        });
      });

    };

    /* --------------- ServiceDB Interface --------------- */

    function _patchServiceDB(data) {
      var operations = _filterOperations(data);
      _updatesToServiceDB(operations.updateOperations);
      _pushToServiceDB(operations.createOperations);
    };

    function _pushToServiceDB(array) {
      for(var i=0; i<array.length; i++) view_model.serviceDB.push(array[i]);
    };

    function _updatesToServiceDB(array) {
      for(var i=0; i<array.length; i++) {
        var indexJSON = {};
        _.set(indexJSON, view_model.primaryKeyProperty, _.get(array[i], view_model.primaryKeyProperty));
        var matchID = _.findIndex(view_model.serviceDB, indexJSON);
        if(matchID > -1) view_model.serviceDB[matchID] = array[i];
      }
    };

    function _getLocalRecords(sinceTime) {
      return _.filter(view_model.serviceDB, function(o) {
        return new Date(_.get(o, view_model.timestampProperty)).toISOString() > sinceTime;
      });
    };

    /* --------------- Data Handling --------------- */

    /* Filter remote data into create or update operations */
    function _filterOperations(data) {
      var updateOps = [];
      var createOps = [];
      for(var i=0; i<data.length; i++) {
        var queryJSON = {};
        _.set(queryJSON, view_model.primaryKeyProperty, _.get(data[i], view_model.primaryKeyProperty));
        var query = _.findIndex(view_model.serviceDB, queryJSON);
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

    function _getRemoteRecords(callback) {
      $http({
          method: 'GET',
          url: view_model.readAPI + view_model.lastChecked
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
      if(!_hasIndexedDB()) { callback(); /* No browser support for IDB */ return; }
      console.log("BP0");
      var request = view_model.indexedDB.open(view_model.indexedDBDatabaseName, view_model.indexedDBVersionNumber);
      console.log("BP0.5");
      request.onupgradeneeded = function(e) {
        console.log("BP1");
        var db = e.target.result;
        e.target.transaction.onerror = function() { console.error(this.error); };
        if(db.objectStoreNames.contains(view_model.objectStoreName)) {
          db.deleteObjectStore(view_model.objectStoreName);
        }
        console.log("BP2");
        var offlineItems = db.createObjectStore(view_model.objectStoreName, { keyPath: view_model.primaryKeyProperty, autoIncrement: false } );
        var dateIndex = offlineItems.createIndex("byDate", view_model.timestampProperty, {unique: false});
        view_model.idb = db;
      };
      request.onsuccess = function(e) {
        view_model.idb = e.target.result;
        callback();
      };
      request.onerror = function() { console.error(this.error); };
    };

    function _hasIndexedDB() {
      return !(view_model.indexedDB === undefined || view_model.indexedDB === null );
    };

    // Get from IndexedDB. This function returns appropriate records.
    function _getIndexedDB(callback) {
      var transaction = _newIDBTransaction();
      var objStore = transaction.objectStore(view_model.objectStoreName);
      var keyRange = IDBKeyRange.lowerBound(0);
      var cursorRequest = objStore.index('byDate').openCursor(keyRange);
      var returnableItems = [];
      transaction.oncomplete = function(e) { callback(_stripAngularHashKeys(returnableItems)); };
      cursorRequest.onsuccess = function(e) {
        var result = e.target.result;
        if (!!result == false) { return; }
        returnableItems.push(result.value);
        result.continue();
      };
      cursorRequest.onerror = function() { console.error("error"); };
    };

    // Apply array of edited objects to IndexedDB.
    function _putArrayToIndexedDB(array, callback) {
      var x = 0;
      if(array.length == 0) {
        callback();
        return;
      }

      var objStore = _newIDBTransaction().objectStore(view_model.objectStoreName);

      function putNext() {
        if(x < array.length) {
          objStore.put(array[x]).onsuccess = function() {
            x++;
            putNext();
          };
        } else {
          callback();
        }
      }
      putNext();

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

    function _stripAngularHashKeys(array) {
      for(var i=0; i<array.length; i++) delete array[i].$$hashKey;
      return array;
    };

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
