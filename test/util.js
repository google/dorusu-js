var path = require('path');
var fs = require('fs');
var http2  = require('http2');
var net = require('net');
var url = require('url');
var spawn = require('child_process').spawn;

function noop() {}
exports.noop = noop;

if (process.env.HTTP2_LOG) {
  var logOutput = process.stderr;
  if (process.stderr.isTTY) {
    var bin = path.resolve(path.dirname(require.resolve('bunyan')), '..', 'bin', 'bunyan');
    if(bin && fs.existsSync(bin)) {
      logOutput = spawn(bin, ['-o', 'short'], {
        stdio: [null, process.stderr, process.stderr]
      }).stdin;
    }
  }
  exports.createLogger = function(name) {
    return require('bunyan').createLogger({
      name: name,
      stream: logOutput,
      level: process.env.HTTP2_LOG,
      serializers: http2.protocol.serializers
    });
  };
  exports.log = exports.createLogger('test');
  exports.clientLog = exports.createLogger('client');
  exports.serverLog = exports.createLogger('server');
} else {
  exports.createLogger = function() {
    return exports.log;
  };
  exports.log = exports.clientLog = exports.serverLog = {
    fatal: noop,
    error: noop,
    warn : noop,
    info : noop,
    debug: noop,
    trace: noop,

    child: function() { return this; }
  };
}

exports.callNTimes = function callNTimes(limit, done) {
  if (limit === 0) {
    done();
  } else {
    var i = 0;
    return function() {
      i += 1;
      if (i === limit) {
        done();
      }
    };
  }
};

exports.secureOptions = {
  key: fs.readFileSync(path.join(__dirname, '../example/server1.key')),
  cert: fs.readFileSync(path.join(__dirname, '../example/server1.pem')),
  ca: fs.readFileSync(path.join(__dirname, '../example/ca.pem'))
};

exports.insecureOptions = {
  protocol: 'http:',
  plain: true
};

exports.nextAvailablePort = nextAvailablePort;
/**
 * Finds a free port that a server can bind to, return an address
 *
 * @param {function(addr)} done is called with the free address
 */
function nextAvailablePort(done) {
  var server = net.createServer();
  server.listen(function() {
    var addr = server.address();
    server.close(function() {
      done(addr);
    });
  });
}

/**
 * Runs `srv` on the next available free port, and executes a `clientTask` that
 * may access the running server.
 *
 * clientTasks is a function(addr, srv) where addr represents the address that
 * server is running and srv is the srv instance.
 *
 * @param {object} srv a server instance
 * @param {function} clientTask that
 */
exports.listenOnFreePort = function listenOnFreePort(srv, clientTask) {
  var startServer = function startServer(addr) {
    srv.listen(addr.port, function() {
      clientTask(addr, srv);
    });
  };
  nextAvailablePort(startServer);
};

// Concatenate an array of buffers into a new buffer
exports.concat = function concat(buffers) {
  var size = 0;
  for (var i = 0; i < buffers.length; i++) {
    size += buffers[i].length;
  }

  var concatenated = new Buffer(size);
  for (var cursor = 0, j = 0; j < buffers.length; cursor += buffers[j].length, j++) {
    buffers[j].copy(concatenated, cursor);
  }

  return concatenated;
};

exports.random = function random(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
};

// Concatenate an array of buffers and then cut them into random size buffers
exports.shuffleBuffers = function shuffleBuffers(buffers) {
  var concatenated = exports.concat(buffers), output = [], written = 0;

  while (written < concatenated.length) {
    var chunk_size = Math.min(concatenated.length - written, Math.ceil(Math.random()*20));
    output.push(concatenated.slice(written, written + chunk_size));
    written += chunk_size;
  }

  return output;
};

// reverser is used as a test serialization func
exports.reverser = function reverser(s) {
  var r = s.toString().split('').reverse().join('');
  return new Buffer(r);
};

// irreverser is used as a test deserialization func
exports.irreverser = function irreverser(s) {
  return s.toString().split('').reverse().join('');
};
