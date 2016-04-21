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

  it('should have an objStore function', function() {
    expect(Offlinify.objStore).toBeDefined();
  });

  it('should not allow the exposure of internal functions', function() {
    expect(Offlinify.sync).not.toBeDefined();
  });

});

describe('objStore declaration', function() {

  /* Test Config */
  var testName = "testJasmineStore";
  var testPrimaryKeyProperty = "id";
  var testTimestampProperty = "timestamp";
  var testReadURL = "http://offlinify.io/api/get";
  var testCreateURL = "http://offlinify.io/api/post";

  /* Spy on console errors */
  beforeEach(function(){
    spyOn(console, 'error');
  });

  it('should declare ' + testName + ' as a complete objStore', function() {
    Offlinify.objStore(testName, testPrimaryKeyProperty, testTimestampProperty, testReadURL, testCreateURL);
    var allObjStores = Offlinify.objStoreMap();
    expect(allObjStores[0].name).toBe(testName);
    expect(allObjStores[0].primaryKeyProperty).toBe(testPrimaryKeyProperty);
    expect(allObjStores[0].timestampProperty).toBe(testTimestampProperty);
    expect(allObjStores[0].readURL).toBe(testReadURL);
    expect(allObjStores[0].createURL).toBe(testCreateURL);
    expect(allObjStores[0].data).toBeDefined();
  });

  it('should not accept creation of a second objStore, also called ' + testName, function() {
    Offlinify.objStore(testName, testPrimaryKeyProperty, testTimestampProperty, testReadURL, testCreateURL);
    expect(console.error).toHaveBeenCalled();
  });

  it('should not accept an invalid objStore declaration', function() {
    Offlinify.objStore(testName);
    expect(console.error).toHaveBeenCalled();
  });

  it('should have designated an updateURL automatically after none was specified', function() {
    expect(Offlinify.objStoreMap()[0].updateURL).toBe(testCreateURL);
  });
});
