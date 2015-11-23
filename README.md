# Nurpc - gRPC for Node.js in Node.js

### Status
- Most interop tests, including (auth tests) pass running against the production interop server
  - Last Step (11/21/2015): Added auth interop tests, verified them against the production interop server
  - Next Step: Error pass, add any outstanding beta interop tests
  - Next Next Step: Write sample code accessing the logging service, a simple google service
- Issues
  - Interop server rejects secure requests in Node 5.0, but works in Node 0.12.7, need to confirm in Node 4.0 and fix it.

### PREREQUISITES
- `node`: This requires `node` to be installed.
- You can install `node` quickly and conveniently using [nvm][], which also allows easy testing on multiple node versions.

### INSTALLATION
- At the moment the package is unpublished so it needs to be installed from source.
```shell
$ # (from this directory)
$ npm update
```

### EXAMPLES
Once installed, try out the math_server and math_client
```shell
$ # (from this directory)
$ example/math_server.js &
$ # (same directory, another terminal window)
$ example/math_client.js
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
