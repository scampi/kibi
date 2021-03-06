var _       = require('lodash');
var Promise = require('bluebird');
var url     = require('url');
var config  = require('../../config');
var logger  = require('../logger');
var AbstractQuery = require('./abstractQuery');
var jdbcHelper    = require('./jdbcHelper');
var Jdbc    = require('jdbc-sindicetech');

var debug = false;

function JdbcQuery(queryDefinition, cache) {
  AbstractQuery.call(this, queryDefinition, cache);
  this.initialized = false;
  this.jdbc = new Jdbc();
  this._init().then(function (data) {
    logger.info(data);
  });
}

JdbcQuery.prototype = _.create(AbstractQuery.prototype, {
  'constructor': JdbcQuery
});

JdbcQuery.prototype._init = function () {
  var self = this;
  if (self.initialized === true) {
    return Promise.resolve({'message': 'JDBC driver already initialized'});
  }

  var jdbcConfig = jdbcHelper.prepareJdbcConfig(this.config.datasourceId);

  return new Promise(function (fulfill, reject) {

    self.jdbc.initialize(jdbcConfig, function (err, res) {
      if (err) {
        reject(err);
      }
      self.initialized = true;
      fulfill({'message': 'Jdbc driver initialization successfully done'});
    });
  });
};


JdbcQuery.prototype._closeConnection = function (conn) {
  // here because of setImediate is used to process rows lets wait at least few ms to close the connection
  // without this the connection was getting close before setImmediate fired
  setTimeout(function () {

    conn.close(function (err) {
      if (err) {
        logger.error(err);
      }
    });

  }, 100);
};

/* return a promise which when resolved should return
 * a following response object
 * {
 *    "boolean": true/false
 * }
 */
JdbcQuery.prototype.checkIfItIsRelevant = function (uri) {
  var self = this;

  return self._init().then(function (data) {

    if (self.requireEntityURI && (!uri || uri === '')) {
      return Promise.reject('Got empty uri while it is required by mysql activation query');
    }

    var datasource = config.kibana.datasources[self.config.datasourceId];
    var query = self._getSqlQueryFromConfig(self.config.activationQuery, uri);

    if (query.trim() === '') {
      return Promise.resolve({'boolean': true});
    }

    var cache_key = this.generateCacheKey(datasource.uri, query);

    if (self.cache) {
      var v = self.cache.get(cache_key);
      if (v) {
        return Promise.resolve(v);
      }
    }

    return new Promise(function (fulfill, reject) {
      self.jdbc.open(function (err, conn) {
        if (err) {
          reject(err);
        }

        if (conn) {
          self.jdbc.executeQuery(query, function (err, results) {
            if (err) {
              reject(err);
            }
            // do something
            var data = {'boolean': results.length > 0 ? true : false};
            if (self.cache) {
              self.cache.set(cache_key, data, datasource.maxAge);
            }
            fulfill(data);
            self._closeConnection(conn);
          });
        }
      });
    });
  });
};

JdbcQuery.prototype.fetchResults = function (uri, onlyIds, idVariableName) {
  var self = this;
  return self._init().then(function (data) {

    var start = new Date().getTime();

    var datasource = config.kibana.datasources[self.config.datasourceId];
    var query = self._getSqlQueryFromConfig(self.config.resultQuery, uri);

    // special case - we can not simply reject the Promise
    // bacause it will cause the whole group of promissses to be rejected
    if (self.resultQueryRequireEntityURI && (!uri || uri === '')) {
      return self._returnAnEmptyQueryResultsPromise('No data because the query require entityURI');
    }

    var cache_key = this.generateCacheKey(datasource.uri, query, onlyIds, idVariableName);

    if (self.cache) {
      var v =  self.cache.get(cache_key);
      if (v) {
        v.queryExecutionTime = new Date().getTime() - start;
        return Promise.resolve(v);
      }
    }


    return new Promise(function (fulfill, reject) {
      self.jdbc.open(function (err, conn) {
        if (err) {
          reject(err);
        }

        if (conn) {
          self.jdbc.executeQuery(query, function (err, results) {
            if (err) {
              if (err.message) {
                err = {
                  error: err,
                  message: err.message
                };
              }
              reject(err);
            }

            var data = {
              ids: [],
              queryActivated: true
            };

            if (!onlyIds) {
              var fields;

              data.head = {
                vars: []
              };
              data.config = {
                label: self.config.label,
                esFieldName: self.config.esFieldName
              };
              data.results = {
                bindings: _.map(results, function (row) {
                  var res = {};

                  if (!fields) {
                    fields = Object.keys(row);
                  }
                  for (var v in row) {
                    if (row.hasOwnProperty(v)) {
                      res[v] = {
                        type: 'unknown', // the driver does not return any information about the fields
                        value: row[v]
                      };
                    }
                  }
                  return res;
                })
              };

              if (fields) {
                data.head.vars = fields;
              }
            }

            if (idVariableName) {
              data.ids = self._extractIdsFromSql(results, idVariableName);
            }

            if (self.cache) {
              self.cache.set(cache_key, data, datasource.maxAge);
            }

            data.debug = {
              sentDatasourceId: self.config.datasourceId,
              sentResultQuery: query,
              queryExecutionTime: new Date().getTime() - start
            };

            fulfill(data);
            self._closeConnection(conn);

          });
        }
      }); // end of jdbc open
    });
  });
};

JdbcQuery.prototype._postprocessResults = function (data) {
  return data;
};


module.exports = JdbcQuery;
