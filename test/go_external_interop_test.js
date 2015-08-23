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
var secureOptions = require('./util').secureOptions;
var server = require('../lib/server')

var GoAgent = require('../interop/go_interop_agent').GoAgent;
var Readable = require('stream').Readable;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

http2.globalAgent = new http2.Agent({ log: clientLog });

var testOptions = {
  secure: secureOptions,
  insecure: insecureOptions
};

describe('External Interop: Nodejs/Go', function() {
  var testpb = protobuf.loadProto(path.join(__dirname, '../interop/test.proto'));
  var interopCtor = buildClient(testpb.grpc.testing.TestService.client);
  var theClient, agent;
  _.forEach(testOptions, function(serverOpts, connType) {
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
        if (agent.isServerRunning) {
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
    return server.raw.createServer(opts, nurpc.notFound);
  } else {
    return server.createServer(opts, nurpc.notFound);
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
      }, 1000);  /* Need to wait around 1s to ensure Go server is up */
    };
    agent._setupAndInstall(agent.testServerDir, startAgentServer);
  };
  nextAvailablePort(createAgent);
};
