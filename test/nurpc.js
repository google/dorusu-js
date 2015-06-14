'use strict';

var expect = require('chai').expect;
var fs = require('fs');
var http2 = require('http2');
var path = require('path');
var nurpc = require('../lib/nurpc');
var util = require('./util');

var options = {
  key: fs.readFileSync(path.join(__dirname, '../example/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '../example/localhost.crt')),
  log: util.serverLog
};


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

describe('nurpc', function() {
  describe('method `isReservedHeader(headerName)`', function() {
    var colonStarters = [':random', ':authority', ':host'];
      colonStarters.forEach(function(h) {
      it('should be true for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.true;
      });
    });
    nurpc.reservedHeaders.forEach(function(h) {
      it('should be true for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.true;
      });
    });
    var unreservedHeaders =  [
      'myapp-foo',
      'myapp-bar',
      'x-my-well-known-header',
    ];
    unreservedHeaders.forEach(function(h) {
      it('should be false for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.false;
      });
    });
  });
  describe('method `h2NameToRpcName`', function() {
    it('should return UNKNOWN for an invalid name', function() {
      expect(nurpc.h2NameToRpcName('foo')).to.eql('UNKNOWN');
    });
    var unmapped = ['HTTP_1_1_REQUIRED', 'STREAM_CLOSED'];
    var h2Codes = nurpc.h2Codes;
    h2Codes.forEach(function(c) {
      if (unmapped.indexOf(c) == -1) {
        it('should return a valid name for ' + c, function() {
          expect(nurpc.h2NameToRpcName(c)).to.be.ok;
          expect(nurpc.h2NameToRpcName(c)).to.not.eql('UNKNOWN');
          });
      }
    });
    unmapped.forEach(function(c) {
      it('should return null for ' + c, function() {
        expect(nurpc.h2NameToRpcName(c)).to.be.null;
      });
    });
  });

  describe('method `rpcCode`', function() {
    it('should throw an exception for unknown names', function() {
      expect(function() { nurpc.rpcCode('foo'); }).to.throw(Error);
    });
    nurpc.rpcCodes.forEach(function(c) {
      it('should return a valid code for ' + c, function() {
        expect(nurpc.rpcCode(c)).to.be.at.least(0);
      });
    });
  });
});

describe('nurpc', function() {
  describe('Agent', function() {
    describe('method `request(options, [callback])`', function() {
      it('should throw when trying to use with \'http\' scheme', function() {
        expect(function() {
          var agent = new http2.Agent({ log: util.clientLog });
          agent.request({ protocol: 'http:' });
        }).to.throw(Error);
      });
    });
  });
  describe('OutgoingRequest', function() {
    function testFallbackProxyMethod(name, originalArguments, done) {
      var request = new http2.OutgoingRequest();

      // When in HTTP/2 mode, this call should be ignored
      request.stream = { reset: util.noop };
      request[name].apply(request, originalArguments);
      delete request.stream;

      // When in fallback mode, this call should be forwarded
      request[name].apply(request, originalArguments);
      var mockFallbackRequest = { on: util.noop };
      mockFallbackRequest[name] = function() {
        expect(Array.prototype.slice.call(arguments)).to.deep.equal(originalArguments);
        done();
      };
      request._fallback(mockFallbackRequest);
    }
  });
  describe('OutgoingResponse', function() {
    it('should throw error when writeHead is called multiple times on it', function() {
      var called = false;
      var stream = { _log: util.log, headers: function () {
        if (called) {
          throw new Error('Should not send headers twice');
        } else {
          called = true;
        }
      }, once: util.noop };
      var response = new http2.OutgoingResponse(stream);

      response.writeHead(200);
      response.writeHead(404);
    });
  });
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

        server.listen(1414, function() {
          http2.get('https://localhost:1414' + path, function(response) {
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

    describe('simple request', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1234, function() {
          http2.get('https://localhost:1234' + path, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              server.close();
              done();
            });
          });
        });
      });
    });
    describe('2 simple request in parallel', function() {
      it('should work as expected', function(originalDone) {
        var path = '/x';
        var message = 'Hello world';
        var done = util.callNTimes(2, function() {
          server.close();
          originalDone();
        });

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1234, function() {
          http2.get('https://localhost:1234' + path, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              done();
            });
          });
          http2.get('https://localhost:1234' + path, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              done();
            });
          });
        });
      });
    });
    describe('100 simple request in a series', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        var n = 100;
        server.listen(1242, function() {
          doRequest();
          function doRequest() {
            http2.get('https://localhost:1242' + path, function(response) {
              response.on('data', function(data) {
                expect(data.toString()).to.equal(message);
                if (n) {
                  n -= 1;
                  doRequest();
                } else {
                  server.close();
                  done();
                }
              });
            });
          }
        });
      });
    });
    describe('request with payload', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(message);
            response.end();
          });
        });

        server.listen(1240, function() {
          var request = http2.request({
            host: 'localhost',
            port: 1240,
            path: path
          });
          request.write(message);
          request.end();
          request.on('response', function() {
            server.close();
            done();
          });
        });
      });
    });
    describe('request with custom status code and headers', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';
        var headerName = 'name';
        var headerValue = 'value';

        var server = http2.createServer(options, function(request, response) {
          // Request URL and headers
          expect(request.url).to.equal(path);
          expect(request.headers[headerName]).to.equal(headerValue);

          // A header to be overwritten later
          response.setHeader(headerName, 'to be overwritten');
          expect(response.getHeader(headerName)).to.equal('to be overwritten');

          // A header to be deleted
          response.setHeader('nonexistent', 'x');
          response.removeHeader('nonexistent');
          expect(response.getHeader('nonexistent')).to.equal(undefined);

          // Don't send date
          response.sendDate = false;

          // Specifying more headers, the status code and a reason phrase with `writeHead`
          var moreHeaders = {};
          moreHeaders[headerName] = headerValue;
          response.writeHead(600, 'to be discarded', moreHeaders);
          expect(response.getHeader(headerName)).to.equal(headerValue);

          // Empty response body
          response.end(message);
        });

        server.listen(1239, function() {
          var headers = {};
          headers[headerName] = headerValue;
          var request = http2.request({
            host: 'localhost',
            port: 1239,
            path: path,
            headers: headers
          });
          request.end();
          request.on('response', function(response) {
            expect(response.headers[headerName]).to.equal(headerValue);
            expect(response.headers['nonexistent']).to.equal(undefined);
            expect(response.headers['date']).to.equal(undefined);
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              server.close();
              done();
            });
          });
        });
      });
    });
    describe('request over plain TCP', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.raw.createServer({
          log: util.serverLog
        }, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1237, function() {
          var request = http2.raw.request({
            plain: true,
            host: 'localhost',
            port: 1237,
            path: path
          }, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              server.close();
              done();
            });
          });
          request.end();
        });
      });
    });
    describe('get over plain TCP', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.raw.createServer({
          log: util.serverLog
        }, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1237, function() {
          var request = http2.raw.get('http://localhost:1237/x', function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              server.close();
              done();
            });
          });
          request.end();
        });
      });
    });
    describe('two parallel request', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1237, function() {
          done = util.callNTimes(2, done);
          // 1. request
          http2.get('https://localhost:1237' + path, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              done();
            });
          });
          // 2. request
          http2.get('https://localhost:1237' + path, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              done();
            });
          });
        });
      });
    });
    describe('two subsequent request', function() {
      it('should use the same HTTP/2 connection', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1238, function() {
          // 1. request
          http2.get('https://localhost:1238' + path, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);

              // 2. request
              http2.get('https://localhost:1238' + path, function(response) {
                response.on('data', function(data) {
                  expect(data.toString()).to.equal(message);
                  done();
                });
              });
            });
          });
        });
      });
    });
    describe('request and response with trailers', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';
        var requestTrailers = { 'content-md5': 'x' };
        var responseTrailers = { 'content-md5': 'y' };

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          request.on('data', util.noop);
          request.once('end', function() {
            expect(request.trailers).to.deep.equal(requestTrailers);
            response.write(message);
            response.addTrailers(responseTrailers);
            response.end();
          });
        });

        server.listen(1241, function() {
          var request = http2.request('https://localhost:1241' + path);
          request.addTrailers(requestTrailers);
          request.end();
          request.on('response', function(response) {
            response.on('data', util.noop);
            response.once('end', function() {
              expect(response.trailers).to.deep.equal(responseTrailers);
              done();
            });
          });
        });
      });
    });
    describe('server push', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';
        var pushedPath = '/y';
        var pushedMessage = 'Hello world 2';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          var push1 = response.push('/y');
          push1.end(pushedMessage);
          var push2 = response.push({ path: '/y', protocol: 'https:' });
          push2.end(pushedMessage);
          response.end(message);
        });

        server.listen(1235, function() {
          var request = http2.get('https://localhost:1235' + path);
          done = util.callNTimes(5, done);

          request.on('response', function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(message);
              done();
            });
            response.on('end', done);
          });

          request.on('push', function(promise) {
            expect(promise.url).to.be.equal(pushedPath);
            promise.on('response', function(pushStream) {
              pushStream.on('data', function(data) {
                expect(data.toString()).to.equal(pushedMessage);
                done();
              });
              pushStream.on('end', done);
            });
          });
        });
      });
    });
  });
});
