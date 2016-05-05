/* -------------------- Offlinify Test Spec -------------------- */

var objStore =  {
  name: "Jasmine-TestObjStore",
  primaryKeyProp: "id",
  timestampProp: "timestamp",
  readURL: "http://offlinify.io/api/get?after=",
  createURL: "http://offlinify.io/api/post"
};

beforeEach(function() {
  Offlinify.wipe();
});

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
  });

  it('does not expose private methods, such as sync()', function() {
    expect(Offlinify.sync).not.toBeDefined();
  });

});

/* ------------------ Object Store -------------------- */

describe('Object Store Methods', function() {

  it('allows the programmatic creation of an objStore', function() {
    Offlinify.objectStore(objStore.name, objStore.primaryKeyProp, objStore.timestampProp, objStore.readURL, objStore.createURL);
  });

});
