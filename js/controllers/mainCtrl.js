'use strict';

angular.module('offlineApp')
  .controller('mainCtrl', function($scope, offlineDB) {

    /* Controller Model */
    $scope.dataModel = [];

    // Function declarations:
    $scope.forceRefresh = forceRefresh;
    $scope.objectUpdate = offlineDB.objectUpdate;

    /* Controller observer-pattern function */
    var updateCtrl = function(response) {
      $scope.dataModel = offlineDB.serviceDB;
      _updateToUI("Update: " + response);
    };

    // Register this controller with the service:
    offlineDB.registerController(updateCtrl);

    // Force a sync cycle when a user requests it:
    function forceRefresh() {
      offlineDB.newSyncThree(function(response) {
        updateCtrl(response);
      });
    };

    function _updateToUI(text) {
      $scope.$applyAsync();
      _sendNotification(text);
    }

    function _sendNotification(text) {
      $.notify(text, {position: "bottom right", showDuration: 100, className: "success"});
    };

  });
