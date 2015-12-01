# Nurpc - gRPC for Node.js in Node.js


### Status
- Most interop tests, including (auth tests) pass running against the production interop server
  - Last Step (11/21/2015): Added auth interop tests, verified them against the production interop server
  - Next Step: Error pass, add any outstanding beta interop tests
  - Next Next Step: Write sample code accessing the logging service, a simple google service
- Issues
  - Interop server rejects secure requests in Node 5.0, but works in Node 0.12.7, need to confirm in Node 4.0 and fix it.

### EXAMPLES

Given the greeter protobuf IDL: helloworld.proto

```protobuf

syntax = "proto3";

option java_package = "ex.grpc";

package helloworld;

// The greeting service definition.
service Greeter {
  // Sends a greeting
  rpc SayHello (HelloRequest) returns (HelloReply) {}
}

// The request message containing the user's name.
message HelloRequest {
  string name = 1;
}

// The response message containing the greetings
message HelloReply {
  string message = 1;
}

```

Serve greetings with a server: helloworld_server.js

```javascript

var app = require('nurpc/app');
var protobuf = require('nurpc/protobuf');
var server = require('nurpc/server');

/**
 * Implements the SayHello RPC method.
 */
function sayHello(request, response) {
  request.on('data', function(msg) {
    response.write({message: 'Hello ' + msg.name});
  });
  request.on('end', function() {
    response.end();
  });
  request.on('error', function() {
    response.end();
  });
};

/**
 * Starts an RPC server that receives requests for the Greeter service at the
 * sample server port
 */
function main() {
  var hellopb = protobuf.loadProto(path.join(__dirname, 'helloworld.proto'));
  var app = new app.RpcApp(hellopb.ex.grpc.Greeter.server);
  app.register('/ex.grpc/SayHello', sayHello);

  /* server.raw.CreateServer is insecure, server.createServer is alway secure */
  s = server.raw.createServer({
    app: app,
    host: '0.0.0.0'
  });
  s.listen(50051);
}

main();

```

Access greetings with a client: helloworld_client.js

```javascript
var buildClient = require('nurpc/client').buildClient;
var protobuf = require('nurpc/protobuf');

function main() {
  var hellopb = protobuf.loadProto(path.join(__dirname, 'helloworld.proto'));
  var Ctor = buildClient(hellopb.ex.grpc.Greeter.client);
  var client = new Ctor({
    host: 'localhost',
    plain: true,  /* connections are secure by default */
    port: 50051,
    protocol: 'http:'
  });

  var user = process.argv[2] || 'world';
  // Call the say hello method remotely.
  client.sayHello({name: user}, function (resp) {
    resp.on('data', function(pb) {
      console.log('Greeting:', pb.message);
    });
  });
}

main();
```

Try it out

```shell
$
$ node helloworld_server.js &
$ node helloworld_client.js
$ node helloworld_client.js nurpc
```


You can also try out the large examples math_server and math_client
```shell
$ # (from this directory)
$ example/math_server.js &
$ # (same directory, another terminal window)
$ example/math_client.js
```

### PREREQUISITES
- `node`: This requires `node` to be installed.
- You can install `node` quickly and conveniently using [nvm][], which also allows easy testing on multiple node versions.

### INSTALLATION
- At the moment the package is unpublished so it needs to be installed from source.
```shell
$ # (from this directory)
$ npm update
```


Try it out with much nicer log output by installing [bunyan][]
```shell
$ npm install -g bunyan # installs bunyan, may require sudo depending on how node is set up
$ # (from this directory)
$ HTTP2_LOG=info example/math_server.js | bunyan -o short &
$ # (same directory, another terminal window)
$ example/math_client.js
$ HTTP2_LOG=info example/math_client.js | bunyan -o short
```

### TESTING
To run the test suite, simply run `npm test` in the install location.

You can also run the interop test client/server:
```shell
$ # (from this directory)
$ # Install bunyan to give readable logs
$ [sudo] npm install -g bunyan # installs bunyan, gives good interop output
$
$ # Run against the production test server
$ HTTP2_LOG=info interop/interop_client.js \
  --server_host grpc-test.sandbox.google.com \
  --server_port 443 \
  --secure \
  --test_case all | bunyan -o short
$
$ # Run against a node interop test server
$ HTTP2_LOG=info interop/interop_server.js -p 50443 | bunyan -o short # (in one terminal)
$ HTTP2_LOG=info interop/interop_client.js \
  --server_host localhost \
  --server_port 50443 \
  --secure \
  --test_case all | bunyan -o short  # in another terminal
```

### DESIGN SUMMARY

nurpc aims to provide strongly-idiomatic client and server implementations supporting the gRPC protocol.

The main governing power behind the nurpc API design is that it provides elements similar to the existing node.js [HTTP2 API][], node-http2, (which is in turn very similar to the node [HTTP API]/[HTTPS API]).

In part, the similarity comes from re-use via extension of classes defined in node-http2.  In other cases the classes have been copied and modified to enforce additional restrictions the [RPC Protocol][] places on the use [HTTP2][].

The goal of the design is that
- the client rpc api surface has a strong similarity to how client code in node.js applications looks.
- the server rpc api surface has a strong similarity to the [Express API][]

The result should be an rpc client and server with an intuitive surface that is easily adopted through its similarity with existing node.js code.
I.e, most of the API will already be familiar to developers, and important new rpc features like streaming requests and response appear as minor deltas that are easily understood.

[HTTP2 API]:https://github.com/molnarg/node-http
[HTTPS API]:http://nodejs.org/api/https.html
[HTTP API]:http://nodejs.org/api/http.html
[RPC protocol]: https://github.com/grpc/grpc-common/blob/master/PROTOCOL-HTTP2.md
[HTTP2]:http://tools.ietf.org/html/draft-ietf-httpbis-http2-16#section-8.1.2.4
[Express API]:http://expressjs.com/4x/api.html
[nvm]: https://github.com/creationix/nvm
[nodejs-legacy]:https://packages.debian.org/sid/nodejs-legacy
[bunyan]:http://trentm.com/talk-bunyan-in-prod/#/
