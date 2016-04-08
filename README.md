# Dorusu-js - gRPC for Node.js in javascript

This is **not** an official Google project.

The official Google-maintained implementation of gRPC for node.js is available
at [grpc-nodejs][].

This is an alternate implementation written in javascript by a Googler. It

- interoperates successfully with the official gRPC implementations, i.e it
  implements the [gRPC spec][] and passes all the core [gRPC interop tests][]

- has an incompatible API surface to [grpc-nodejs][], for reasons explained
  in the [DESIGN SUMMARY](#design_summary).

  - **TODO on github** Add a documentation issue that explains the differences
    via code snippets embedded in the issue.

  - **TODO on github** This means this library cannot be used as a drop-in
  replacement for code written using [grpc-nodejs][].  Add a tracking issue to
  triage any impact this has on users, and to discuss various approaches and to
  be the focus for resolving these issues.

[grpc-nodejs]:https://github.com/grpc/grpc/tree/master/src/node
[gRPC spec]:https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md
[grpc interop tests]:https://github.com/grpc/grpc/blob/master/doc/interop-test-descriptions.md

## DESIGN SUMMARY

dorusu-js provides strongly-idiomatic client and server implementations
supporting the gRPC rpc protocol.

The main governing power behind the dorusu API design is that it provides
elements similar to the existing node.js [HTTP2 API][], node-http2, which
is in turn very similar to the node [HTTP API][]/[HTTPS API][].

In part, the similarity comes from direct use of classes defined in
[node-http2][].  In other cases the classes have been extended to
enforce additional restrictions the [RPC Protocol][] places on the use
[HTTP2][].

The goal of the design is that
- the client rpc api surface has a strong similarity to the builtin node.js https library surface
- the server rpc api surface has a strong similarity to the [Express API][]

The result should be an rpc client and server with an intuitive surface that is
easy to learn due to its similarity to existing node.js code.  I.e, most of the
API should already be familiar to developers, and important new rpc features like
streaming requests and responses are available as minor deltas that are easily
understood.

[HTTP2 API]:https://github.com/molnarg/node-http
[HTTPS API]:http://nodejs.org/api/https.html
[HTTP API]:http://nodejs.org/api/http.html
[RPC protocol]: https://github.com/grpc/grpc-common/blob/master/PROTOCOL-HTTP2.md
[HTTP2]:http://tools.ietf.org/html/draft-ietf-httpbis-http2-16#section-8.1.2.4
[Express API]:http://expressjs.com/4x/api.html

## EXAMPLES

### Given the greeter protobuf IDL: helloworld.proto

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

### Serve greetings with a server: helloworld_server.js

```javascript

var app = require('dorusu/app');
var protobuf = require('dorusu/protobuf');
var server = require('dorusu/server');

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

### Access greetings with a client: helloworld_client.js

```javascript
var buildClient = require('dorusu/client').buildClient;
var protobuf = require('dorusu/protobuf');

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

### Try it out

```bash
node helloworld_server.js &
node helloworld_client.js
node helloworld_client.js dorusu
```

### Other examples
You can also try out the large math_server and math_client examples in this repo

```bash
npm update  # install dorusu locally
example/math_server.js &

# (same directory, another terminal window)
example/math_client.js
```

Try it out with much nicer log output by installing [bunyan][]

```bash
npm install -g bunyan # installs bunyan, may require sudo depending on how node is set up

# (from this directory)
HTTP2_LOG=info example/math_server.js | bunyan -o short &

# (same directory, another terminal)
example/math_client.js
HTTP2_LOG=info example/math_client.js | bunyan -o short
```

[nvm]: https://github.com/creationix/nvm
[bunyan]:http://trentm.com/talk-bunyan-in-prod/#/
[node-http2]::https://github.com/molnarg/node-http

## TESTING

### unit tests
```bash
npm test
```

### interop tests
```bash
npm run interop-test
```
_Note_ The node interop test client is tested against the node interop test server as part of the [unit tests](#unit_tests).   `interop-test` here actual runs against [grpc-go][].

- the test is skipped unless Go is installed.
- when Go is available, test test installs [grpc-go][] to a temporary location and runs the interop the client against the grpc-go server and vice versa.

[grpc-go]:https://github.com/grpc/grpc-go
