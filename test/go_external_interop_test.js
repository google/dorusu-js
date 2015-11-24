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
var nextAvailablePort = require('./util').nextAvailablePort;
var nurpc = require('../lib/nurpc');
var path = require('path');
var protobuf = require('../lib/protobuf');
var server = require('../lib/server')

var GoAgent = require('../interop/go_interop_agent').GoAgent;
var Readable = require('stream').Readable;

http2.globalAgent = new http2.Agent({ log: clientLog });

var testClientOptions = {
  secure: require('../example/certs').clientOptions,
  insecure: insecureOptions
};

var TEST_PROTO_PATH = path.join(__dirname, '../interop/test.proto');

describe('External Interop Nodejs/Go', function() {
  /* Adjust the test timeout/duration; Go is spawned in a child proc */
  this.slow(5000);
  this.timeout(8000);

  var testpb = protobuf.loadProto(TEST_PROTO_PATH);
  var interopCtor = buildClient(testpb.grpc.testing.TestService.client);
  var theClient, agent;
  _.forEach(testClientOptions, function(serverOpts, connType) {
    describe(connType, function() {
      before(function(done) {
        serverOpts.app = buildApp();
        var setUpClient = function setUpClient(err, theAgent) {
          if (err != null) {
            done(err);
            return;
          }
          agent = theAgent;
          var stubOpts = {log: clientLog};
          var serverAddr = {
            port: agent.port,
            address: 'localhost',
            family: 'IPv4'
          };
          _.merge(stubOpts, serverAddr, serverOpts);
          theClient = new interopCtor(stubOpts);
          done();
        }
        makeGoServer(serverOpts, setUpClient);
      });
      after(function() {
        if (agent && agent.isServerRunning) {
          serverLog.info('stopping server', {'port': agent.port });
          agent.stopServer();
        }
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

describe('External Interop Go/Nodejs', function() {
  var testpb = protobuf.loadProto(path.join(__dirname, '../interop/test.proto'));
  var interopCtor = buildClient(testpb.grpc.testing.TestService.client);
  var theAgent, server, serverAddr;
  _.forEach(testOptions, function(serverOpts, connType) {
    describe(connType, function() {
      before(function(done) {
        serverOpts.app = buildApp();
        server = makeNodeServer(serverOpts);
        var stubOpts = {log: clientLog};
        listenOnFreePort(server, function(addr, server) {
          serverAddr = addr;
          var opts = {log: clientLog};
          _.merge(opts, serverAddr);
          theAgent = new GoAgent(opts);
          done();
        });
      })
      after(function() {
        server.close();
      })
      var testCases = [
        'cancel_after_begin',
        'cancel_after_first_response',
        'empty_unary',
        'large_unary',
        'client_streaming',
        'server_streaming',
        'ping_pong',
        'empty_stream',
        'timeout_on_sleeping_server'
      ];
      _.forEach(testCases, function(t) {
        it('should pass the ' + t + ' interop test' , function(done) {
          theAgent.runInteropTest(t, {secure: connType === 'secure'}, done);
        });
      })
    });
  });
});

function makeNodeServer(opts) {
  opts = _.clone(opts);
  opts.log = serverLog;
  if (opts.plain) {
    return server.raw.createServer(opts, nurpc.unavailable);
  } else {
    return server.createServer(opts, nurpc.unavailable);
  }
};

function makeGoServer(opts, done) {
  opts = _.clone(opts);
  opts.log = serverLog;
  var agent = null;
  var createAgent = function createAgent(addr) {
    var agentOpts = {};
    _.merge(agentOpts, addr, opts);
    agent = new GoAgent(agentOpts);
    var insecure = !!opts.plain;
    var startAgentServer =  function(err) {
      if (err != null) {
        done(err);
        return;
      }
      agent.startServer(!insecure, done);
      setTimeout(function() {
        done(null, agent);
      }, startupWaitMillis);
    };
    agent._setupAndInstall(agent.testServerDir, startAgentServer);
  };
  nextAvailablePort(createAgent);
};
