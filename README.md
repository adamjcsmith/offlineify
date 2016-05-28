# Offlinify

Allows the routing of API data through IndexedDB, through easy-to-use functions.
Should be useful for the handling and storage of data for web applications which
significantly utilise asynchronous/ajax connections and require a safeguard
against intermittent connections, or for web applications which could be used
fully offline (e.g. with AppCache or Service Workers).

No jQuery needed. An example integration with AngularJS is available at [offlinify-angular](https://github.com/adamjcsmith/offlinify-angular).

## Prerequisities
Offlinify requires the Lodash library, JSON-based APIs, ISO-8601 timestamps and UUIDs in order to work (see below). It does not require jQuery. The plugin will work in browsers that support the IndexedDB API ([see browser support here](http://caniuse.com/#feat=indexeddb)). It is also strongly recommended that you use IndexedDBShim - Offlinify supports it - but it is optional.

#### Browser Support
* IE10+ / Edge 11+
* Chrome 11+
* Firefox 4+
* Safari Desktop 7.1+ / iOS Safari 8+
* Opera 15+
* Android Browser 4.4+

#### Timestamps
Offlinify requires ISO-8601 timestamps to request
new data from an API and patch it locally. Your GET request URLS should
accept a querystring parameter with a timestamp, e.g:

```
http://offlinify.io/api/get?after=2016-01-01T00:00:00.000Z
```
The querystring can be of any name, but must be appended to the GET URL supplied
when the plugin storages are declared (see below). A spinout project,
[offlinify-io](https://github.com/adamjcsmith/offlinify-io), emulates the required API querystring as shown above. The source code should be useful for any Node.js-based REST API
as a reference on how to handle ISO-8601 timestamps.

#### UUIDs
In order to create uniquely identifiable objects while offline, Offlinify requires objects sent in JSON notation from your API to use UUIDs (v4) and not numeric integers.

#### Lodash
Numerous internal functions rely on Lodash, a functional JavaScript library. Include it into your project before Offlinify. See the reference [here](lodash.com). Note: Offlinify _may_ work with Underscore, but it has not been tested yet.

## Installation

Download the source directory and link to Offlinify in your main HTML or template
file, like so:
```
<script src="offlinify/dist/offlinify.js"></script>
```
After including the .js file, Offlinify will now be a global variable where you can access any of the public API methods, which are detailed below. An example setup is given towards the bottom of this readme file.

## Example Usage
You first need to declare your object stores, then initialise, then use the data functions. Data handling functions - such as objectUpdate() or wrapData() - will not execute unless the plugin has been initialised.

Below is a simple example. The POST url for the api here would accept a create or update operation. First define an object store, then initialise with no arguments, then use the data.

```
Offlinify.objectStore('person', 'id', 'timestamp', '/api/get?after=', '/api/post');
```
Now that an object store has been declared, we can initialise without any arguments:
```
Offlinify.init();
```
Finally, we can use the plugin, so let's get the data. The wrapData() function is just akin to executing an ajax request, so let's use it like so:
```
Offlinify.wrapData('person', function(data) {
    console.log("We have data! " + JSON.stringify(data));
});
```
Our data would then be printed to the console, like this:
```
1:  We have data! {id: "205c1f82-996f-4d14-9bc1-1055263ab6d7", name: "Adam"}
```
Let's try adding a birth year to this person, using objectUpdate. Let's amend our original example to add a birth year to the returned record, then update the record. We need to make some acceptance/synchronisation callbacks too, don't forget.
```
Offlinify.wrapData('person', function(data) {
    data[0].birthYear = 1993;
    console.log(data[0]);
    var acceptCallback = function() { console.log("Accepted!"); };
    var syncCallback = function() { console.log("Synchronised!"); };
    var errorCallback = function() { console.log("Error. :("); };
    Offlinify.objectUpdate(data, 'person', acceptCallback, syncCallback, errorCallback);
});
```
This looks fine, so on the console we would get:
```
1:  {id: "205c1f82-996f-4d14-9bc1-1055263ab6d7", name: "Adam", birthYear: 1993}
2:  Accepted!
3:  Synchronised!
```

## API Reference

The API could be sub-divided into setup and data-handling methods. Offlinify requires all 'object stores' to be declared before it is initialised.

### Offlinify.objectStore
Defines an **object store**. Each GET url should have its own object store. For example, you may have one for each layer of a map, or for entities such as people or locations.

```javascript
Offlinify.objectStore(name, primaryKey, timetamp, getURL, createURL, updateURL, readPrefix, postPrefix)
```
##### name
_Required_. Name your object store, for example, _"person"_.

##### primaryKey
_Required_. Supply the path to your UUID property, for example, _"id"_.

##### timestamp
_Required_. Supply the path to your (ISO-8601) timestamp property, for example, _"timestamp"_.

##### getURL
_Required_. Supply a url where the plugin can access your data with a GET request, appending your timestamp queryString to the end. For example, _"http://offlinify.io/api/get?after="_.

##### createURL
_Required_. Supply a url where the plugin can send a POST request to your API with a newly created object. For example, _"http://offlinify.io/api/post"_. Potentially, your API may have a single POST URL, for example one which accepts both create and update operations. If this is the case, there is no need to supply a duplicate updateURL - updated objects will be sent to the createURL you supply if no updateURL is specified.

##### updateURL
_Optional_. Supply a url where the plugin can send a POST request to your API with an updated object. For example, _"http://offlinify.io/api/post"_.

##### readPrefix
_Optional_. The actual data returned from a GET request to your API may be in an embedded array, if this is the case, supply the path to the actual data. For example, _"data"_.

##### postPrefix
_Optional_. Wrap post requested objects sent to your API with a property name. For example, for geoJSON this might be _"geojson"_.


### Offlinify.init
After listing all of the objectStores you require, call init with any configuration parameters required. Pass in an object literal with the configuration you require.
```
Offlinify.init(configuration)
```
**autoSync** - allows a background loop to poll your API for new data, or sync changed local data.
```
default: 0
options: integer (milliseconds)
```

**pushSync** - a sync cycle is triggered when an object is created or updated when true.
```
default: true
options: boolean
```

**csrfCookieHeader** - sends a csrf token from your cookie in the header of POST requests when true.
```
default: true
options: boolean
```

**allowIndexedDB** - emulates no browser support for indexedDB when true.
```
default: true
options: boolean
```

**allowRemote** - emulates no connection to API when true.
```
default: true
options: boolean
```

**retryOnResponseCodes** - retry sending data to API when these response codes are received.
```
default: [401,500,502]
options: integer array[]
```

**replaceOnResponseCodes** - replace local data when these response codes are received.
```
default: [400,403,404]
options: integer array[]
```

**maxRetry** - number of tries to synchronise retried data to the API.
```
default: 100
options: integer
```

**indexedDBDatabaseName** - name of the local IndexedDB database.
```
default: "offlinifyDB-2"
options: string
```

### Offlinify.objectUpdate
Accepts an object. If a UUID is present in the object then the call will be treated as an _update_ operation, otherwise it will be treated as a create. Timestamps are generated automatically. Accepts callback functions for acceptance, synchronisation and error events.

##### object
_Required_. A JavaScript object.

##### objectStore
_Required_. The name of a valid object store, defined beforehand using **objectStore()**.

##### acceptCallback
_Required_. Function called when the object has been saved to IndexedDB and is queued to be synchronised remotely.

##### syncCallback
_Required_. Function called when the object has been POSTed to the API successfully (a 200 response code was received).

##### errorCallback
_Required_. Function called when an invalid object is passed, or the POST request to the API returned a response code specified in the _replaceOnResponseCodes_ array (by default these are [400,403,404]).

### Offlinify.wrapData
Returns the data stored in an object store, in the same format as received by GET requests returned from the remote API.

##### objectStore
_Required_. The name of a valid object store, defined beforehand using **objectStore()**.

##### callback
_Required_. Function executed when request is finished, passed with the returned data.

### Offlinify.subscribe
Enables the observer pattern for Offlinify, accepting a callback to be executed when a new view of local data is available.

##### callback
_Required_. Function executed when a sync cycle is complete. New remote data may be available, or any conflicts may be resolved.

### Offlinify.objStoreMap
Returns a list of all current object stores. Accepts no arguments.

### Offlinify.saveContext
Enables the saving of environment-like variables in a (key, value) store. Useful for saving user settings or permissions between offline sessions. Semantically data which may be manipulated offline, but should not be synchronised to the server should be stored here. Accepts an object with a property 'key', defining the name of the variable.

##### variableObject
_Required_. A JavaScript object with a property 'key' which defines the variable name.

##### callback
_Required_. Function executed when save operation was successful.

### Offlinify.getContext
Accepts a key, and returns a variable from context storage.

##### key
_Required_. String key to identify the desired variable.

##### callback
_Required_. Function executed when the get operation was successful, passed with the returned variable.

### Offlinify.wipe
Allows the safe clearing of both IndexedDB and the DOM storage. Operation is always executed when a sync cycle is not in progress. Accepts no arguments.

### Offlinify.wipeImmediately
Allows an unsafe, immediate clearing of both IndexedDB and DOM storage. Operation may be executed whilst a sync cycle is in progress, and therefore this operation is not recommended unless for testing purposes.


## Tests

A small number of Jasmine tests are included in the /test directory. [Jasmine documentation](jasmine.github.io).

## Deployment

It is strongly recommended that you install [IndexedDBShim](https://github.com/axemclion/IndexedDBShim) if you implement Offlinify. This is an excellent shim written by Parashuram which uses WebSQL (a pre-IndexedDB form of local storage) as a fallback for some older browsers.

## Integrations

An AngularJS example of how Offlinify can be integrated like a service is available at another repo, [adamjcsmith/offlinify-angular](https://github.com/adamjcsmith/offlinify-angular).

## Acknowledgements

* UUID(v4) implementation in JavaScript. Briguy37 / Stackoverflow community. [Link](http://stackoverflow.com/a/8809472/3381433).

## License

This project is licensed under the MIT license.
