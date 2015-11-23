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
        _.merge(headers, authHdrs)
        done(null, headers);
      });
    });
  };
};

/**
 * Get a function that obtains an auth token 'OOB' using Google's ADC,
 * then re-uses that token all the time without falling back to ADC.
 *
 * @return {function(authUri, headers, done)} A function that updates the
 *   headers passed and invokes done with the result
 */
exports.addAuthFromOobADC = function addAuthFromOobADC(opt_scopes) {
  var oob = exports.addAuthFromADC(opt_scopes);
  var token

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
      })
    } else {
      headers = _.merge({'authorization': token}, headers);
      done(null, headers);
    }
  };
};
