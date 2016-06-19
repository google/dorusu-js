#!/usr/bin/env node
/*
 *
 * Copyright 2015, Google Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 */
'use strict';

/**
 * dorusu/interop/interop_client is the client for the grpc.testing.TestService
 *
 * It implements the service defined in test.proto, which is used to validate
 * rpc protocol implementations.
 *
 * Example usage:
 *
 * Run all tests the insecure interop server at the default local port.
 * ```sh
 * $ interop_client.js
 * ```
 *
 * Run all test on secure server with info logging
 * ```sh
 * $ HTTP2_LOG=info interop_client.js \
 *    -p 443 -a my.domain.io -s | bunyan -o short
 * ```
 *
 * Print full usage for description of other flags and options
 * ```sh
 * $ interop_client.js -h
 * ```
 *
 * @module dorusu/interop/interop_client
 */

var _ = require('lodash');
var async = require('async');
var bunyan = require('bunyan');
var chai = require('chai');
chai.use(require('dirty-chai'));
var expect = chai.expect;
var http2 = require('http2');
var insecureOptions = require('../test/util').insecureOptions;
var dorusu = require('../lib');
var secureOptions = require('../example/certs').clientOptions;

var ArgumentParser = require('argparse').ArgumentParser;
var Readable = require('stream').Readable;
var PassThrough = require('stream').PassThrough;

/**
 * Create a buffer filled with `size` zeroes.
 *
 * @param {number} size The length of the buffer
 * @return {Buffer} buffer
 */
function zeroes(size) {
  var b = new Buffer(size);
  b.fill(0);
  return b;
}

/**
 * Get a function that obtains an auth token 'OOB' using Google's ADC,
 * then re-uses that token all the time without falling back to ADC.
 *
 * @return {function(authUri, headers, done)} A function that updates the
 *   headers passed and invokes done with the result
 */
var addAuthFromOobADC = function addAuthFromOobADC(opt_scopes) {
  var oob = dorusu.addAuthFromADC(opt_scopes);
  var token;

  /**
   * Update an headers array with authentication information.
   *
   * @param {string} opt_authURI The uri to authenticate to
   * @param {Object} headers the current headers
   * @param {function(Error, Object)} done the node completion callback called
   *                                       with the updated headers
   */
  return function updateHeaders(opt_authURI, headers, done) {
    if (!token) {
      oob(opt_authURI, headers, function(err, updatedHeaders) {
        if (err) {
          done(err);
          return;
        }
        token = updatedHeaders.Authorization;
        done(null, updatedHeaders);
      });
    } else {
      headers = _.merge({'authorization': token}, headers);
      done(null, headers);
    }
  };
};

exports.emptyUnary = function emptyUnary(client, next) {
  var gotMsg;
  var saveMessage = function(msg) {
    gotMsg = msg;
  };

  // Run the test.
  var req = {};
  var onEnd = function() {
    expect(gotMsg).to.eql({});
    dorusu.logger.info('Verified: ok emptyCall(', req, ') =>', gotMsg);
    next();
  };
  dorusu.logger.info('Checking: emptyCall');
  client.emptyCall(req, function(response) {
    response.on('end', onEnd);
    response.on('data', saveMessage);
  });
};

exports.largeUnary = function largeUnary(client, next) {
  var gotMsg;
  var saveMessage = function(msg) {
    gotMsg = msg;
  };
  var onEnd = function() {
    expect(gotMsg.payload.type).to.eql('COMPRESSABLE');
    expect(gotMsg.payload.body.length).to.eql(314159);
    dorusu.logger.info('Verified: largeUnary(...) => (', gotMsg, ')');
    next();
  };

  // Run the test.
  var req = {
    response_type: 'COMPRESSABLE',
    response_size: 314159,
    payload: {
      body: zeroes(271828)
    }
  };
  dorusu.logger.info('Checking: largeUnary');
  client.unaryCall(req, function(response) {
    response.on('end', onEnd);
    response.on('data', saveMessage);
  });
};

var loadWantedEmail = function loadWantedEmail(next) {
  var credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credsPath) {
    next(new Error('The ADC env variable required for this test is not set'));
    return;
  }
  try {
    var creds = require(credsPath);
    next(null, creds.client_email);
  } catch (err) {
    next(err);
    return;
  }
};

exports.computeEngine = function computeEngine(Ctor, opts, args, next) {
  var wantedEmail = args.default_service_email_address;
  var gotMsg;
  var saveMessage = function(msg) {
    gotMsg = msg;
  };
  var onEnd = function onEnd() {
    expect(gotMsg.payload.type).to.eql('COMPRESSABLE');
    expect(gotMsg.payload.body.length).to.eql(314159);
    expect(gotMsg.username).to.eql(wantedEmail);
    dorusu.logger.info('Verified: computeEngine had email %s', wantedEmail);
    next();
  };

  // Run the test.
  var req = {
    fill_oauth_scope: true,
    fill_username: true,
    payload: {
      body: zeroes(271828)
    },
    response_size: 314159,
    response_type: 'COMPRESSABLE'
  };
  opts.updateHeaders = dorusu.addAuthFromADC();  // no scope needed on GCE
  var client = new Ctor(opts);
  dorusu.logger.info('Checking: computeEngine');
  client.unaryCall(req, function(response) {
    response.on('end', onEnd);
    response.on('data', saveMessage);
  });
};

exports.jwtTokenCreds = function jwtTokenCreds(Ctor, opts, args, next) {
  var gotMsg;
  var saveMessage = function(msg) {
    gotMsg = msg;
  };
  var onEnd = function onEnd() {
    loadWantedEmail(function(err, wantedEmail) {
      if (err) {
        next(err);
        return;
      }
      expect(gotMsg.payload.type).to.eql('COMPRESSABLE');
      expect(gotMsg.payload.body.length).to.eql(314159);
      expect(gotMsg.username).to.eql(wantedEmail);
      dorusu.logger.info('Verified: jwtTokenCreds had email %s', gotMsg.username);
      next();
    });
  };

  // Run the test.
  opts.updateHeaders = dorusu.addAuthFromADC();  // no scopes for jwt token
  var client = new Ctor(opts);
  var req = {
    fill_oauth_scope: true,
    fill_username: true,
    payload: {
      body: zeroes(271828)
    },
    response_size: 314159,
    response_type: 'COMPRESSABLE'
  };
  dorusu.logger.info('Checking: jwtTokens');
  client.unaryCall(req, function(response) {
    response.on('end', onEnd);
    response.on('data', saveMessage);
  });
};

exports.oauth2AuthToken = function oauth2AuthToken(Ctor, opts, args, next) {
  var gotMsg;
  var saveMessage = function(msg) {
    gotMsg = msg;
  };
  var onEnd = function onEnd() {
    loadWantedEmail(function(err, wantedEmail) {
      if (err) {
        next(err);
        return;
      }
      expect(gotMsg.payload.type).to.eql('COMPRESSABLE');
      expect(gotMsg.payload.body.length).to.eql(314159);
      expect(gotMsg.oauth_scope).to.not.be.empty();
      expect(args.oauth_scope).to.have.string(gotMsg.oauth_scope);
      expect(gotMsg.username).to.eql(wantedEmail);
      dorusu.logger.info('Verified: oauth2AuthToken had scope %s', gotMsg.oauth_scope);
      next();
    });
  };

  // Run the test.
  opts.updateHeaders = addAuthFromOobADC(args.oauth_scope);
  var client = new Ctor(opts);
  var req = {
    fill_oauth_scope: true,
    fill_username: true,
    payload: {
      body: zeroes(271828)
    },
    response_size: 314159,
    response_type: 'COMPRESSABLE'
  };
  dorusu.logger.info('Checking: oauth2AuthToken');
  client.unaryCall(req, function(response) {
    response.on('end', onEnd);
    response.on('data', saveMessage);
  });
};

/**
 * Confirms that credentials can be added per rpc.
 *
 * N.B - the difference between this and service account creds
 * is that the updateHeaders func is passed as an option on the
 * RPC call, rather than option to the RPC client (Stub) constructor.
 */
exports.perRpcCreds = function perRpcCreds(Ctor, opts, args, next) {
  var gotMsg;
  var saveMessage = function(msg) {
    gotMsg = msg;
  };
  var onEnd = function onEnd() {
    loadWantedEmail(function(err, wantedEmail) {
      if (err) {
        next(err);
        return;
      }
      expect(gotMsg.payload.type).to.eql('COMPRESSABLE');
      expect(gotMsg.payload.body.length).to.eql(314159);
      expect(gotMsg.oauth_scope).to.not.be.empty();
      expect(args.oauth_scope).to.have.string(gotMsg.oauth_scope);
      expect(gotMsg.username).to.eql(wantedEmail);
      dorusu.logger.info('Verified: perRpcCreds had scope %s', gotMsg.oauth_scope);
    });
    next();
  };

  // Run the test.
  var client = new Ctor(opts);
  var req = {
    fill_oauth_scope: true,
    fill_username: true,
    payload: {
      body: zeroes(271828)
    },
    response_size: 314159,
    response_type: 'COMPRESSABLE'
  };
  dorusu.logger.info('Checking: perRpcCreds');
  client.unaryCall(req, function(response) {
    response.on('end', onEnd);
    response.on('data', saveMessage);
  }, {
    updateHeaders: dorusu.addAuthFromADC(args.oauth_scope)
  });
};

exports.serviceAccount = function serviceAccount(Ctor, opts, args, next) {
  var gotMsg;
  var saveMessage = function(msg) {
    gotMsg = msg;
  };
  var onEnd = function onEnd() {
    loadWantedEmail(function(err, wantedEmail) {
      if (err) {
        next(err);
        return;
      }
      expect(gotMsg.payload.type).to.eql('COMPRESSABLE');
      expect(gotMsg.payload.body.length).to.eql(314159);
      expect(gotMsg.oauth_scope).to.not.be.empty();
      expect(args.oauth_scope).to.have.string(gotMsg.oauth_scope);
      expect(gotMsg.username).to.eql(wantedEmail);
      dorusu.logger.info('Verified: serviceAccountCreds had scope %s', gotMsg.oauth_scope);
      next();
    });
  };

  // Run the test.
  opts.updateHeaders = dorusu.addAuthFromADC(args.oauth_scope);
  var client = new Ctor(opts);
  var req = {
    fill_oauth_scope: true,
    fill_username: true,
    payload: {
      body: zeroes(271828)
    },
    response_size: 314159,
    response_type: 'COMPRESSABLE'
  };
  dorusu.logger.info('Checking: serviceAccount');
  client.unaryCall(req, function(response) {
    response.on('end', onEnd);
    response.on('data', saveMessage);
  });
};

exports.clientStreaming = function clientStreaming(client, next) {
  var done = next || _.noop;
  var gotMsg;
  var saveMessage = function(msg) {
    gotMsg = msg;
  };
  var onEnd = function onEnd() {
    expect(gotMsg.aggregated_payload_size).to.eql(74922);
    dorusu.logger.info('Verified: OK, clientStreaming sent 74922 bytes');
    done();
  };

  // Run the test.
  var payloadSizes = [27182, 8, 1828, 45904];
  var src = new Readable({objectMode: true});
  for (var i = 0; i < payloadSizes.length; i++) {
    src.push({payload: {body: zeroes(payloadSizes[i])}});
  }
  src.push(null);
  dorusu.logger.info('Checking: clientStreaming');
  client.streamingInputCall(src, function(response) {
    response.on('end', onEnd);
    response.on('data', saveMessage);
  });
};

exports.cancelAfterBegin = function cancelAfterBegin(client, next) {
  var done = next || _.noop;
  var verifyWasCancelled = function verifyWasCancelled(code) {
    var wantedCode = dorusu.rpcCode('CANCELLED');
    expect(code).to.equal(wantedCode);
    dorusu.logger.info('Verified: OK, cancelAfterBegin had cancelled OK');
    done();
  };

  // Run the test.
  var src = new PassThrough({objectMode: true});
  dorusu.logger.info('Checking: cancelAfterBegin');
  var req = client.streamingInputCall(src, _.noop);
  req.on('cancel', verifyWasCancelled);
  req.cancel();
};

exports.cancelAfterFirst = function cancelAfterFirst(client, next) {
  var payloadSizes = [27182, 8, 1828, 45904];
  var responseSizes = [31415, 9, 2653, 58979];
  var src = new PassThrough({objectMode: true});
  var index = 0;
  var nextPing = function nextPing() {
    if (index === 4) {
      dorusu.logger.info('cancelAfterFirst: ending after', index, 'pings');
      src.end();
    } else {
      dorusu.logger.info('cancelAfterFirst: writing message #', index);
      src.write({
        response_type: 'COMPRESSABLE',
        response_parameters: [
          {size: responseSizes[index]}
        ],
        payload: {body: zeroes(payloadSizes[index])}
      });
    }
  };
  var cancelled = false;
  var req;
  var verifyEachMessage = function verifyEachMessage(msg) {
    dorusu.logger.info('cancelAfterFirst: receiving index:', index);
    expect(msg.payload.type).to.eql('COMPRESSABLE');
    expect(msg.payload.body.lengh, responseSizes[index]);
    index += 1;
    if (index === 1 && req) {
      dorusu.logger.info('... cancelling after', index, 'msg');
      req.cancel();
    }
    nextPing();
  };
  var done = next || _.noop;
  var onEnd = function onEnd() {
    expect(cancelled).to.be.true();
    dorusu.logger.info('Verified: cancelAfterFirst cancelled after', index, 'msg');
    done();
  };

  // Run the test.
  nextPing();  // start with a ping
  dorusu.logger.info('Checking: cancelAfterFirst');
  req = client.fullDuplexCall(src, function onResponse(response) {
    response.on('data', verifyEachMessage);
    response.on('end', onEnd);
  });
  req.on('cancel', function onCancel() {
    cancelled = true;
  });
};

exports.timeoutOnSleeper = function timeoutOnSleeper(client, next) {
  var done = next || _.noop;
  var payloadSizes = [27182, 8, 1828, 45904];
  var responseSizes = [31415, 9, 2653, 58979];
  var src = new PassThrough({objectMode: true});
  var index = 0;
  var nextPing = function nextPing() {
    if (index === 4) {
      dorusu.logger.info('timeoutOnSleeper: ending after', index, 'pings');
      src.end();
    } else {
      dorusu.logger.info('timeoutOnSleeper: writing message #', index);
      src.write({
        response_type: 'COMPRESSABLE',
        response_parameters: [
          {size: responseSizes[index]}
        ],
        payload: {body: zeroes(payloadSizes[index])}
      });
    }
  };
  var verifyEachMessage = function verifyEachMessage(msg) {
    dorusu.logger.info('timeoutOnSleeper: receiving index:', index);
    expect(msg.payload.type).to.eql('COMPRESSABLE');
    expect(msg.payload.body.lengh, responseSizes[index]);
    index += 1;
    nextPing();
  };
  var verifyCancelled = function() {
    expect(index).to.be.below(payloadSizes.length);
    dorusu.logger.info('Verified: timeoutOnSleeper cancelled after', index, 'msg');
    done();
  };

  // Run the test.
  nextPing();  // start with a ping
  dorusu.logger.info('Checking: timeoutOnSleeper');
  var req = client.fullDuplexCall(src, function onResponse(response) {
    response.on('data', verifyEachMessage);
  }, {
    headers: {
      'grpc-timeout': '1m'
    }
  });
  req.on('cancel', verifyCancelled);
};

exports.serverStreaming = function serverStreaming(client, next) {
  var index = 0;
  var done = next || _.noop;
  var req = {
    response_type: 'COMPRESSABLE',
    response_parameters: [
      {size: 31415},
      {size: 9},
      {size: 2653},
      {size: 58979}
    ]
  };
  var verifyEachMessage = function verifyEachMessage(msg) {
    expect(msg.payload.type).to.eql('COMPRESSABLE');
    expect(msg.payload.body.lengh,
           req.response_parameters[index].size);
    index += 1;
  };

  // Run the test.
  dorusu.logger.info('Checking: serverStreaming');
  client.streamingOutputCall(req, function(response) {
    response.on('end', function() {
      dorusu.logger.info('Verified: streamingStreaming received', index, 'msgs');
      done();
    });
    response.on('data', verifyEachMessage);
  });
};

exports.pingPong = function pingPong(client, next) {
  var done = next || _.noop;
  var payloadSizes = [27182, 8, 1828, 45904];
  var responseSizes = [31415, 9, 2653, 58979];
  var src = new PassThrough({objectMode: true});
  var index = 0;
  var nextPing = function nextPing() {
    if (index === 4) {
      dorusu.logger.info('pingPong: ending after', index, 'pings');
      src.end();
    } else {
      dorusu.logger.info('pingPong: writing message #', index);
      src.write({
        response_type: 'COMPRESSABLE',
        response_parameters: [
          {size: responseSizes[index]}
        ],
        payload: {body: zeroes(payloadSizes[index])}
      });
    }
  };
  var verifyEachMessage = function verifyEachMessage(msg) {
    dorusu.logger.info('pingPong: receiving index:', index);
    expect(msg.payload.type).to.eql('COMPRESSABLE');
    expect(msg.payload.body.lengh, responseSizes[index]);
    index += 1;
    nextPing();
  };

  // Run the test.
  nextPing();  // start with a ping
  dorusu.logger.info('Checking: pingPong');
  client.fullDuplexCall(src, function(response) {
    response.on('end', function() {
      dorusu.logger.info('Verified: pingPong sent/received', index, 'msgs');
      done();
    });
    response.on('data', verifyEachMessage);
  });
};

exports.emptyStream = function emptyStream(client, next) {
  var done = next || _.noop;
  var src = new Readable({objectMode:true});
  src.push(null);  // Do not send any messages;
  dorusu.logger.info('Checking: emptyStream');
  client.fullDuplexCall(src, function(response) {
    response.on('end', function() {
      dorusu.logger.info('Verified: empty stream sent/received');
      done();
    });
    response.on('data', function() {
      expect(true).to.be(false); // should not be called
    });
  });
};

exports.runInteropTest = function runInteropTest(client, testCase, next) {
  var done = next || _.noop;
  if (_.has(exports.withoutAuthTests, testCase)) {
    exports.withoutAuthTests[testCase](client, done);
    return;
  }
  done(new Error('Unknown test case:' + testCase));
};

exports.allWithoutAuth = function allWithoutAuth(client, next) {
  var done = next || _.noop;
  var tasks = [];
  _.forEach(exports.withoutAuthTests, function(f, name) {
    if (name !== 'all') {
      tasks.push(f.bind(null, client));
    }
  });
  async.series(tasks, done);
};

/**
 * The non-auth interop tests that this file implements.
 */
exports.withoutAuthTests = {
  all: exports.allWithoutAuth,
  cancel_after_begin: exports.cancelAfterBegin,
  cancel_after_first_response: exports.cancelAfterFirst,
  large_unary: exports.largeUnary,
  empty_unary: exports.emptyUnary,
  client_streaming: exports.clientStreaming,
  server_streaming: exports.serverStreaming,
  empty_stream: exports.emptyStream,
  timeout_on_sleeping_server: exports.timeoutOnSleeper,
  ping_pong: exports.pingPong
};

/**
 * The auth interop tests that this file implements.
 */
exports.withAuthTests = {
  compute_engine_creds: exports.computeEngine,
  jwt_token_creds: exports.jwtTokenCreds,
  oauth2_auth_token: exports.oauth2AuthToken,
  per_rpc_creds: exports.perRpcCreds,
  service_account_creds: exports.serviceAccount
};

var defaultServerPort = 50051;
var defaultHost = 'localhost';

/**
 * parseArgs parses the command line options/arguments when this file is run as
 * a script.
 */
var parseArgs = function parseArgs() {
  var parser = new ArgumentParser({
    version: require('../package').version,
    addHelp:true,
    description: 'Dorusu Node.js Interoperability Client.\n' +
                 'It accesses an RPC Interoperability Server and performs' +
                 ' test RPCs that demonstrate conformance with the rpc' +
                 ' protocol specification.'
  });
  parser.addArgument(
    [ '-a', '--server_host' ],
    {
      help: 'The Interop Server hostname',
      defaultValue: defaultHost
    }
  );
  parser.addArgument(
    [ '-p', '--server_port' ],
    {
      defaultValue: defaultServerPort,
      help: 'The Interop Server port',
      type: 'int'
    }
  );
  parser.addArgument(
    [ '-s', '--use_tls' ],
    {
      defaultValue: false,
      action: 'storeTrue',
      help: 'When set, indicates that the server should be accessed' +
            ' securely using the example test credentials'
    }
  );
  parser.addArgument(
    [ '-c', '--use_test_ca' ],
    {
      defaultValue: false,
      action: 'storeTrue',
      help: 'When set, TLS connections use the test CA certificate'
    }
  );
  var allTheTests = _.keys(exports.withoutAuthTests);
  allTheTests = _.union(allTheTests, _.keys(exports.withAuthTests));
  parser.addArgument(
    [ '-t', '--test_case' ],
    {
      choices: allTheTests,
      defaultValue: 'all',
      help: 'Specifies the name of the interop test to be run'
    }
  );
  parser.addArgument(
    [ '-o', '--oauth_scope' ],
    {
      defaultValue: '',
      help: 'The scope to use for oauth tokens'
    }
  );
  parser.addArgument(
    [ '-e', '--default_service_email_address' ],
    {
      defaultValue: '',
      help: 'Email address of the default service account'
    }
  );
  parser.addArgument(
    [ '-x', '--server_host_override' ],
    {
      defaultValue: 'foo.test.google.fr',
      help: 'Override hostname via a HTTP Header'
    }
  );
  return parser.parseArgs();
};

/**
 * Provides the command line entry point when this file is run as a script.
 */
var main = function main() {
  var log = bunyan.createLogger({
    name: 'interop_client',
    stream: process.stdout,
    level: process.env.HTTP2_LOG || 'info',
    serializers: http2.serializers
  });
  dorusu.configure({logger: log});

  var args = parseArgs();
  var opts = {
    port: args.server_port,
    host: args.server_host
  };
  if (args.use_tls) {
    _.merge(opts, secureOptions);
  } else {
    _.merge(opts, insecureOptions);
  }
  if (_.has(args, 'server_host_override')) {
    _.merge(opts, {
      rejectUnauthorized: false
    });
  }
  var testpb = dorusu.pb.requireProto('./test', require);
  var TestServiceClient = testpb.grpc.testing.TestService.Client;

  if (_.has(exports.withoutAuthTests, args.test_case)) {
    var client = new TestServiceClient(opts);
    async.series([
      exports.withoutAuthTests[args.test_case].bind(null, client),
      process.exit.bind(null, 0)  /* TODO enable client's to be closed */
    ]);
  } else if (_.has(exports.withAuthTests, args.test_case)) {
    async.series([
      exports.withAuthTests[args.test_case].bind(
        null, TestServiceClient, opts, args),
      process.exit.bind(null, 0)  /* TODO enable client's to be closed */
    ]);
  }
};

if (require.main === module) {
  main();
}
