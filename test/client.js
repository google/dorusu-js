'use strict';

var expect = require('chai').expect;
var fs = require('fs');
var path = require('path');
var util = require('./util');

var Stub = require('../lib/client').Stub;

var options = {
  key: fs.readFileSync(path.join(__dirname, '../example/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '../example/localhost.crt')),
  log: util.serverLog
};

var http2 = require('http2');

// typical tests should
// - start a http2 server
// - send a request using the grpc surface
// - verify behaviour on the server using the http2 surface
// - respond using the http2 surface
// - verify the expected client response

// use the same options object fields names as a http request would use
// refactor surface to the current gRPC one, apart from headers

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var options = {
  key: fs.readFileSync(path.join(__dirname, '../example/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '../example/localhost.crt')),
  log: util.serverLog
};

http2.globalAgent = new http2.Agent({ log: util.clientLog });

describe('client', function() {
  describe('test scenario', function() {
    describe('request-response', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';
        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });
        var request_text = 'hello';
        var response_text = 'world';

        server.listen(1505, function() {
          var stub = new Stub('https://localhost:1505' + path);
          stub.request_response(path, request_text, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
            });

            response.on('end', function() {
              server.close();
              done();
            });
          });
        });
      });
    });
  });
});
