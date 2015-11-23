'use strict';

var _ = require('lodash');
var app = require('../lib/app');
var buildApp = require('../example/math_server').buildApp;
var buildClient = require('../lib/client').buildClient;
var clientLog = require('./util').clientLog;
var serverLog = require('./util').serverLog;
var expect = require('chai').expect;
var http2 = require('http2');
var insecureOptions = require('./util').insecureOptions;
var listenOnFreePort = require('./util').listenOnFreePort;
var mathClient = require('../example/math_client');
var nurpc = require('../lib/nurpc');
var path = require('path');
var protobuf = require('../lib/protobuf');
var secureOptions = require('./util').secureOptions;
var server = require('../lib/server')

var Readable = require('stream').Readable;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

http2.globalAgent = new http2.Agent({ log: clientLog });

var mathpb = protobuf.loadProto(path.join(__dirname, '../example/math.proto'));
var mathClientCls = buildClient(mathpb.math.Math.client);
var testOptions = {
  secure: secureOptions,
  insecure: insecureOptions
};

describe('Math Client', function() {
  var client, server, serverAddr;
  _.forEach(testOptions, function(serverOpts, connType) {
    describe(connType, function() {
      before(function(done) {
        serverOpts.app = buildApp();
        server = makeServer(serverOpts);
        var stubOpts = {};
        listenOnFreePort(server, function(addr, server) {
          serverAddr = addr;
          _.merge(stubOpts, serverAddr, serverOpts);
          client = new mathClientCls(stubOpts);
          done();
        });
      })
      after(function() {
        server.close();
      })
      it('should error on `div` with a 0 divisor', function(done) {
        mathClient.doBadDiv(client, done);
      });
      it('should get the correct answer for `div`', function(done) {
        mathClient.doOkDiv(client, done);
      });
      it('should get the correct response for `fib`', function(done) {
        mathClient.doOkFib(client, done);
      });
      it('should get the correct response for `sum`', function(done) {
        mathClient.doOkSum(client, done);
      });
      it('should get the correct response for `divMany`', function(done) {
        mathClient.doStreamDiv(client, done);
      });
    });
  });
});

function makeServer(opts) {
  opts = _.clone(opts);
  opts.log = serverLog;
  if (opts.plain) {
    return server.raw.createServer(opts, nurpc.unavailable);
  } else {
    return server.createServer(opts, nurpc.unavailable);
  }
};
