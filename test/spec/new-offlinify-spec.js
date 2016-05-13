/* -------------------- Offlinify Test Spec -------------------- */

var objStore =  {
  name: "Jasmine-TestObjStore",
  primaryKeyProp: "id",
  timestampProp: "timestamp",
  readURL: "http://offlinify.io/api/get?after=",
  createURL: "http://offlinify.io/api/post"
};

var obj = {
  test: "this is a test"
};

/* -------------------- API Methods -------------------- */

describe('Available API Methods', function() {

  it('exposes public methods such as init(), objectStore() and subscribe()', function() {
    expect(Offlinify.init).toBeDefined();
    expect(Offlinify.objectStore).toBeDefined();
    expect(Offlinify.subscribe).toBeDefined();
    expect(Offlinify.wrapData).toBeDefined();
    expect(Offlinify.objectUpdate).toBeDefined();
    expect(Offlinify.objStoreMap).toBeDefined();
    expect(Offlinify.wipe).toBeDefined();
    expect(Offlinify.wipeImmediately).toBeDefined();
  });

  it('does not expose private methods, such as sync()', function() {
    expect(Offlinify.sync).not.toBeDefined();
  });

});

/* ------------------ Object Store -------------------- */

describe('Object Store Methods', function() {

  beforeEach(function(){
    spyOn(console, 'error');
  });

  it('allows the programmatic creation of an objStore', function() {
    Offlinify.objectStore(objStore.name, objStore.primaryKeyProp, objStore.timestampProp, objStore.readURL, objStore.createURL);
    var objMap = Offlinify.objStoreMap();
    expect(objMap[0].name).toEqual(objStore.name);
    expect(objMap[0].primaryKeyProperty).toEqual(objStore.primaryKeyProp);
    expect(objMap[0].timestampProp).toEqual(objStore.timestampProperty);
    expect(objMap[0].readURL).toEqual(objStore.readURL);
    expect(objMap[0].createURL).toEqual(objStore.createURL);
  });

  it('rejects a duplicate objStore declaration', function() {
    Offlinify.objectStore(objStore.name, "", "", "", "");
    expect(console.error).toHaveBeenCalled();
  });

  it('rejects an invalid objStore declaration', function() {
    Offlinify.objectStore(objStore.name);
    expect(console.error).toHaveBeenCalled();
  });

  it('specifies an updateURL when none is specified', function() {
    var objMap = Offlinify.objStoreMap();
    expect(objMap[0].updateURL).toEqual(objMap[0].createURL);
  })

});

/* -------------------- Initialisation -------------------- */

describe('Object Creation', function() {

  var receivedObj;

  beforeEach(function(done) {
    Offlinify.wipeImmediately();
    Offlinify.objectStore(objStore.name, objStore.primaryKeyProp, objStore.timestampProp, objStore.readURL, objStore.createURL);
    Offlinify.init();
    Offlinify.objectUpdate(obj, objStore.name, function(recvObj) {
        receivedObj = recvObj;
        done();
    });
  });

  it('creates an object', function() {
    expect(receivedObj.test).toEqual(obj.test);
  });

});
