#!/usr/bin/env node
/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var _ = require('lodash');
var async = require('async');
var fs = require('fs-extra');
var https = require('https');
var glob = require('glob');
var path = require('path');
var tmp = require('tmp');

var StreamZip = require('node-stream-zip');


/**
 * dorusu/tools/sync_grpc_protos is a tool used to sync the grpc protos on the
 * main branch into the this repo.
 *
 * Once, gRPC is GA, it will be updated to sync only from releases.
 */

var GRPC_REPO_ZIP = 'https://github.com/grpc/grpc/archive/master.zip';

function main() {
  function makeTmpDir(next) {
    tmp.dir({}, next);
  }

  function makeTmpZip(dirName, _unused, next) {
    var fileCb = function fileCb(err, tmpPath, fd) {
      next(err, dirName, tmpPath, fd);
    };
    tmp.file({
      mode: 420 /* 0644 */,
      prefix: 'repo-',
      postfix: '.zip' }, fileCb);
  }

  function saveZip(dirname, tmpPath, fd, next) {
    console.log('downloading %s', GRPC_REPO_ZIP);
    var out = fs.createWriteStream('', {
      fd: fd,
      highWaterMark: 1 * 1024 * 1024
    });
    download(GRPC_REPO_ZIP, out, function(err) {
      if (err) {
        console.log('failed to download zip to %s due to %s', tmpPath, err);
        fs.unlink(tmpPath);  // delete the file if an error occurs during writing
        next(err);
      } else {
        console.log('downloaded zip to %s', tmpPath);
        next(null, dirname, tmpPath);
      }
    });
  }

  function extractZip(dirname, tmpPath, next) {
    var zip = new StreamZip({
      file: tmpPath,
      storeEntries: true
    });
    zip.on('error', function(err) { next(err); });
    zip.on('ready', function() {
      zip.extract(null, dirname, function(err) {
        if (err) {
          console.error('unzip failed:', err);
          return next(err);
        }
        return next(null, dirname);
      });
    });
  }

  /* Use glob to copy protos locally */
  function copyProtos(dirName, next) {
    fs.readdir(dirName, function(err, files) {
      if (err) {
        return next(err);
      }
      if (files.length > 1) {
        console.error('malformed zip had', files.length, 'top-level dirs');
        return next(new Error('malformed zip: more than 1 top-level dir'));
      }
      var srcRoot = fs.realpathSync(
        path.join(dirName, files[0], 'src', 'proto'));
      var dstRoot = fs.realpathSync(
        path.join(__dirname, '..', 'pb'));
      var toRemove = null;
      var makeCopies = processPaths(next, function makeACopy(srcs) {
        _.forEach(toRemove, function(old) {
          console.log('removing %s', old);
          fs.unlink(old);
        });
        _.forEach(srcs, function(src) {
          var dst = src.replace(srcRoot, dstRoot);
          fs.mkdirsSync(path.dirname(dst));
          fs.copySync(src, dst);
          console.log('updating %s', dst);
        });
      });

      var doSync = processPaths(next, function(currentProtos) {
        toRemove = currentProtos;
        glob.glob('**/*.proto', {
          cwd: srcRoot,
          realpath: true,
          nodir: true
        }, makeCopies);
      });

      console.log('syncing protobuf files from %s', srcRoot);
      glob.glob('**/*.proto', {
        cwd: dstRoot,
        realpath: true,
        nodir: true
      }, doSync);
    });
  }

  var tasks = [
    makeTmpDir,   // make a tmp directory
    makeTmpZip,   // make a tmp file in which to save the zip
    saveZip,      // pull the zip archive and save it
    extractZip,   // extract the zip and save in the tmp directory
    copyProtos    // copy the protos locally.
  ];
  async.waterfall(tasks, function(err) {
    if (err) {
      console.log('Sync failed: %s', err);
    }
  });
}

function processPaths(done, process) {
  return function(err, outputs) {
    if (err) {
      done(err);
    } else {
      done(null, process(outputs));
    }
  };
}

function download(url, out, cb) {
  var done = cb || _.noop;
  https.get(url, function(response) {
    if (response.statusCode === 302) {
      var location = response.headers.location;
      if (!location) {
        done('bad redirect: did not specify a location');
      } else {
        download(location, out, done);
      }
    } else {
      out.on('finish', function() {
        out.close(done);  // close() is async, call cb after close completes.
      });
      response.pipe(out);
    }
  }).on('error', done);
}

if (require.main === module) {
  main();
}
