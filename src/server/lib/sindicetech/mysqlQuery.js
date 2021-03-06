var _       = require('lodash');
var Promise = require('bluebird');
var url     = require('url');
var config  = require('../../config');
var mysql   = require('mysql');
var logger  = require('../logger');
var AbstractQuery = require('./abstractQuery');

var debug = false;

function MysqlQuery(queryDefinition, cache) {
  AbstractQuery.call(this, queryDefinition, cache);
}

MysqlQuery.prototype = _.create(AbstractQuery.prototype, {
  'constructor': MysqlQuery
});


/* return a promise which when resolved should return
 * a following response object
 * {
 *    "boolean": true/false
 * }
 */
MysqlQuery.prototype.checkIfItIsRelevant = function (uri) {
  if (this.requireEntityURI && (!uri || uri === '')) {
    return Promise.reject('Got empty uri while it is required by mysql activation query');
  }

  var datasource = config.kibana.datasources[this.config.datasourceId];
  var query = this._getSqlQueryFromConfig(this.config.activationQuery, uri);

  if (query.trim() === '') {
    return Promise.resolve({'boolean': true});
  }

  var self = this;

  var cache_key = this.generateCacheKey(datasource.uri, query);

  if (self.cache) {
    var v = self.cache.get(cache_key);
    if (v) {
      return Promise.resolve(v);
    }
  }

  return new Promise(function (fulfill, reject) {
    var connection;
    try {
      connection = mysql.createConnection(datasource.uri);
      connection.connect();
      connection.query({sql: query, timeout: datasource.timeout || 1000}, function (err, rows, fields) {
        if (err) {
          reject(err);
        }
        var data = {'boolean': rows.length > 0 ? true : false};
        if (self.cache) {
          self.cache.set(cache_key, data, datasource.maxAge);
        }
        fulfill(data);
      });
    } catch (err) {
      reject(err);
    } finally {
      if (connection) {
        connection.end();
      }
    }
  });
};


MysqlQuery.prototype._getType = function (typeNum) {
  // Look here https://github.com/felixge/node-mysql/blob/6e87af8cdd40e9fac72d026b049cdd9a24829de5/lib/protocol/constants/types.js
  var types = {
    0: 'DECIMAL',
    1: 'TINY',
    2: 'SHORT',
    3: 'LONG',
    4: 'FLOAT',
    5: 'DOUBLE',
    6: 'NULL',
    7: 'TIMESTAMP',
    8: 'LONGLONG',
    9: 'INT24',
    10: 'DATE',
    11: 'TIME',
    12: 'DATETIME',
    13: 'YEAR',
    14: 'NEWDATE',
    15: 'VARCHAR',
    16: 'BIT',
    246: 'NEWDECIMAL',
    247: 'ENUM',
    248: 'SET',
    249: 'TINY_BLOB',
    250: 'MEDIUM_BLOB',
    251: 'LONG_BLOB',
    252: 'BLOB',
    253: 'VAR_STRING',
    254: 'STRING',
    255: 'GEOMETRY'
  };
  return types[typeNum] ? types[typeNum] : typeNum;
};

MysqlQuery.prototype.fetchResults = function (uri, onlyIds, idVariableName) {
  var start = new Date().getTime();
  var self = this;

  var datasource = config.kibana.datasources[this.config.datasourceId];
  var query = this._getSqlQueryFromConfig(this.config.resultQuery, uri);

  // special case - we can not simply reject the Promise
  // bacause this will cause the whole group of promissses to be rejected
  if (this.resultQueryRequireEntityURI && (!uri || uri === '')) {
    return this._returnAnEmptyQueryResultsPromise('No data because the query require entityURI');
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
    var connection;
    try {
      connection = mysql.createConnection(datasource.uri);
      connection.connect();
      connection.query({sql: query, timeout: datasource.timeout || 1000}, function (err, rows, fields) {
        if (err) {
          if (err.message) {
            err = {
              error: err,
              message: err.message
            };
          }

          reject(err);
          return;
        }

        var data = {
          ids: [],
          queryActivated: true
        };
        if (!onlyIds) {
          var _varTypes = {};
          _.each(fields, function (field) {
            _varTypes[field.name] = self._getType(field.type);
          });

          data.head = {
            vars: _.map(fields, function (field) {
              return field.name;
            })
          };
          data.config = {
            label: self.config.label,
            esFieldName: self.config.esFieldName
          };
          data.results = {
            bindings: _.map(rows, function (row) {
              var res = {};
              for (var v in row) {
                if (row.hasOwnProperty(v)) {
                  res[v] = {
                    type: _varTypes[v],
                    value: row[v]
                  };
                }
              }
              return res;
            })
          };
        }

        if (idVariableName) {
          data.ids = self._extractIdsFromSql(rows, idVariableName);
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
      });
    } catch (err) {
      reject(err);
    } finally {
      if (connection) {
        connection.end();
      }
    }
  });

};

MysqlQuery.prototype._postprocessResults = function (data) {
  return data;
};


module.exports = MysqlQuery;
