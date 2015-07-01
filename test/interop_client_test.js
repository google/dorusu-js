'use strict';

var _ = require('lodash');
var app = require('../lib/app');
var buildApp = require('../interop/interop_server').buildApp;
var buildClient = require('../lib/client').buildClient;
var clientLog = require('./util').clientLog;
var serverLog = require('./util').serverLog;
var expect = require('chai').expect;
var http2 = require('http2');
var insecureOptions = require('./util').insecureOptions;
var interopClient = require('../interop/interop_client');
var listenOnFreePort = require('./util').listenOnFreePort;
var nurpc = require('../lib/nurpc');
var path = require('path');
var protobuf = require('../lib/protobuf');
var secureOptions = require('./util').secureOptions;
var server = require('../lib/server')

var Readable = require('stream').Readable;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

http2.globalAgent = new http2.Agent({ log: clientLog });

var testOptions = {
  secure: secureOptions,
  insecure: insecureOptions
};

describe('Interop Client', function() {
  var testpb = protobuf.loadProto(path.join(__dirname, '../interop/test.proto'));
  var interopCtor = buildClient(testpb.grpc.testing.TestService.client);
  var theClient, server, serverAddr;
  _.forEach(testOptions, function(serverOpts, connType) {
    describe(connType, function() {
      before(function(done) {
        serverOpts.app = buildApp();
        server = makeServer(serverOpts);
        var stubOpts = {log: clientLog};
        listenOnFreePort(server, function(addr, server) {
          serverAddr = addr;
          _.merge(stubOpts, serverAddr, serverOpts);
          theClient = new interopCtor(stubOpts);
          done();
        });
      })
      after(function() {
        server.close();
      })
      var testCases = [
          'empty_unary',
          'large_unary',
          'client_streaming',
          'server_streaming',
          'ping_pong',
          'empty_stream'
      ];
      _.forEach(testCases, function(t) {
        it('should pass the ' + t + ' interop test', function(done) {
          interopClient.runInteropTest(theClient, t, done);
        });
      })
    });
  });
});

function makeServer(opts) {
  opts = _.clone(opts);
  opts.log = serverLog;
  if (opts.plain) {
    return server.raw.createServer(opts, nurpc.notFound);
  } else {
    return server.createServer(opts, nurpc.notFound);
  }
};
