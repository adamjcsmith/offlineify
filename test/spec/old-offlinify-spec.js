describe('Method Availability', function() {

  it('should have an objectUpdate function', function() {
    expect(Offlinify.objectUpdate).toBeDefined();
  });

  it('should have a wrapData function', function() {
    expect(Offlinify.wrapData).toBeDefined();
  });

  it('should have a subscribe function', function() {
    expect(Offlinify.subscribe).toBeDefined();
  });

  it('should have an init function', function() {
    expect(Offlinify.init).toBeDefined();
  });

  it('should have an objectStore function', function() {
    expect(Offlinify.objectStore).toBeDefined();
  });

  it('should not allow the exposure of internal functions', function() {
    expect(Offlinify.sync).not.toBeDefined();
  });

});


/* Test Config */
var testName = "testJasmineStore";
var testPrimaryKeyProperty = "id";
var testTimestampProperty = "timestamp";
var testReadURL = "http://offlinify.io/api/get?after=";
var testCreateURL = "http://offlinify.io/api/post";

var testObject = { timestamp: "2016-01-01T00:00:00.000Z"};


describe('objStore Declaration', function() {

  /* Spy on console errors */
  beforeEach(function(){
    spyOn(console, 'error');
  });

  it('should declare ' + testName + ' as a complete objStore', function() {
    Offlinify.objectStore(testName, testPrimaryKeyProperty, testTimestampProperty, testReadURL, testCreateURL);
    var allObjStores = Offlinify.objStoreMap();
    expect(allObjStores[0].name).toBe(testName);
    expect(allObjStores[0].primaryKeyProperty).toBe(testPrimaryKeyProperty);
    expect(allObjStores[0].timestampProperty).toBe(testTimestampProperty);
    expect(allObjStores[0].readURL).toBe(testReadURL);
    expect(allObjStores[0].createURL).toBe(testCreateURL);
    expect(allObjStores[0].data).toBeDefined();
  });

  it('should not accept creation of a second objStore, also called ' + testName, function() {
    Offlinify.objectStore(testName, testPrimaryKeyProperty, testTimestampProperty, testReadURL, testCreateURL);
    expect(console.error).toHaveBeenCalled();
  });

  it('should not accept an invalid objStore declaration', function() {
    Offlinify.objectStore(testName);
    expect(console.error).toHaveBeenCalled();
  });

  it('should have designated an updateURL automatically after none was specified', function() {
    expect(Offlinify.objStoreMap()[0].updateURL).toBe(testCreateURL);
  });
});

describe('Initialisation', function() {

  /* Spy on console errors */
  beforeEach(function(){
    spyOn(console, 'error');
  });

  it('should initialise with no overrides', function() {
    Offlinify.init({});
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('Object API', function() {

  var receivedObj;

  describe('Successful object creations expected', function() {
    var sentObj = {"test":"this is a test"};

    beforeEach(function(done) {
      Offlinify.objectUpdate(sentObj, testName,
        function(data) { receivedObj = data; done(); },
        function(data) { console.log("Synchronised with remote") },
        function() { done.fail("Fail callback was triggered."); });
    });

    it('should accept a valid object into IndexedDB', function() {
      expect(receivedObj.test).toEqual(sent
        Obj.test);
    });

  });

  describe('Unsuccessful object creations expected', function() {

    var sentObj = {"test":"this is a test"};

    beforeEach(function(done) {
      spyOn(console, 'error');
      Offlinify.objectUpdate(sentObj, "etc",
        function(data) { },
        function(data) { console.log("Synchronised with remote") },
        function() { done(); });
    });

    it('should reject an incorrect objStore', function() {
      expect(console.error).toHaveBeenCalled();
    });

  });


  describe('Read Tests', function() {
    var receivedObjStoreData;

    beforeEach(function(done) {
      Offlinify.wrapData(testName, function(data) {
        receivedObjStoreData = data;
        done();
      });
    });

    it('should retrieve the object from the objStore', function() {
      expect(_.find(receivedObjStoreData, { id : receivedObj.id })).toBeDefined();
    });

    describe('Update Tests', function() {

      console.log(JSON.stringify(receivedObj));

      var updatedObject = { "id": receivedObj.id, "newData": "This is new data." };

      beforeEach(function(done) {
        Offlinify.objectUpdate(updatedObject, testName,
          function(data) { console.log("Received the update!!!"); receivedObj = data; done(); },
          function() { done.fail("Fail callback was triggered."); });
      });

      it('should update an existing object', function() {
        expect(receivedObj.newData).toEqual(updatedObject.newData);
      });

    });



  });


  /* Spy on console errors */
  //beforeEach(function(){
    //spyOn(console, 'error');
  //});


/*
  it('should be rejected with an unknown objStore', function() {
    Offlinify.objectUpdate({}, "unknown", function() { console.log("Synced"); }, function() { console.log("error"); });
    expect(console.error).toHaveBeenCalled();
  });
*/

  /*
  it('should be accepted with valid arguments', function(done) {
    Offlinify.objectUpdate(testObject, testName, function() { console.log("Synced"); }, function() { console.log("error"); });
    expect(console.error).not.toHaveBeenCalled();
  });
  */

});
