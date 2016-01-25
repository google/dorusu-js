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
 * nurpc/googleauth provides a header update function based on
 * google-auth-library.
 *
 * @module nurpc/googleauth
 */

var _ = require('lodash');
var GoogleAuth = require('google-auth-library');
var AuthFactory = new GoogleAuth();

/**
 * Get a function that a client can use to update headers with authorization
 * tokens from a GoogleAuth credential object.
 *
 * @return {function(authUri, headers, done)} A function that updates the
 *   headers passed and invokes done with the result
 */
exports.addAuthFromADC = function addAuthFromADC(opt_scopes) {
  /**
   * Update an headers array with authentication information.
   *
   * @param {string} opt_authURI The uri to authenticate to
   * @param {Object} headers the current headers
   * @param {function(Error, Object)} done the node completion callback called
   *                                       with the updated headers
   */
  return function updateHeaders(opt_authURI, headers, done) {
    AuthFactory.getApplicationDefault(function(err, credential) {
      if (err) {
        done(err);
        return;
      }
      if (credential.createScopedRequired && credential.createScopedRequired()) {
        credential = credential.createScoped(opt_scopes);
      }
      headers = _.merge({}, headers);
      credential.getRequestMetadata(opt_authURI, function(err, authHdrs) {
        if (err) {
          done(err);
          return;
        }
        _.merge(headers, authHdrs);
        done(null, headers);
      });
    });
  };
};
