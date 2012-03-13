var WebSocketServer = require('websocket').server;
var connectionIdCounter = 0;
// Create an express server instance
var express = require('express'),
  mongo = require('mongodb'),
  BSON = mongo.BSONPure.BSON,
  Db = mongo.Db,
  Server = mongo.Server,
  ObjectID = mongo.ObjectID,
  async = require('async'),
  format = require('util').format,
  cluster = require('cluster');

// Setup of ports etc
var port = process.env['APP_PORT'] ? process.env['APP_PORT'] : 3000;
// Environment parameters for db
var dbHost = process.env['DB_HOST'] ? process.env['DB_HOST'] : 'localhost';
var dbPort = process.env['DB_PORT'] ? process.env['DB_PORT'] : 27017;
var dbUser = process.env['DB_USER'] ? process.env['DB_USER'] : 'admin';
var dbPassword = process.env['DB_PASSWORD'] ? process.env['DB_PASSWORD'] : 'admin';

if(cluster.isMaster) {
  console.log("--------------------------------------------------- start application with")
  console.log("app port = " + port)
  console.log("db host = " + dbHost)
  console.log("db port = " + dbPort)
  console.log("db user = " + dbUser)  
}
// Set up server for mongo
var db = new Db('game', new Server(dbHost, dbPort));
var numCPUs = require('os').cpus().length;
var numCPUs = 1;
var gameCollection = null;
var boardCollection = null;

// Contains the game state variables
var state = {
  // Connection information
  connections : {},
  // Collections
  gameCollection: null,
  boardCollection: null,

  // Connections by board id
  connectionsByBoardId: {},
  boardIdByConnections: {}
}

// Create a server instance
var app = express.createServer();
// Set up the configuration for the express server
app.configure(function() {
  app.use(express.static(__dirname + "/public"));
  app.set('views', __dirname);
  app.set('view engine', 'ejs');
});

// Provide the bootstrap file
app.get('/', function(req, res) {
  res.render('index', { layout: false });
});

app.get('/delete', function(req, res) {
  // Remove all boards from play
  state.boardCollection.update({number_of_players: {$lt:100}}, {$set:{number_of_players:100}}, {multi:true});            
  // Render the index again
  res.render('index', { layout: false });
})

//
// Start up the server, using async to manage the flow of calls
//
if(cluster.isMaster) {
  // Do the basic setup for the main process
  // Setting up the db and tables
  async.series([
      function(callback) { db.open(function(err, db) {
        db.admin().authenticate(dbUser, dbPassword, callback);
      }); },
      function(callback) { db.dropCollection('game', function() { callback(null, null); }); },
      function(callback) { db.dropCollection('board', function() { callback(null, null); }); },
      function(callback) { db.createCollection('game', {capped:true, size:100000, safe:true}, callback); },    
      function(callback) { db.createCollection('board', {capped:true, size:100000, safe:true}, callback); },    
      function(callback) { db.ensureIndex('board', {number_of_players:1}, callback); },    
      function(callback) { db.ensureIndex('game', {'id':1}, callback); },    
      function(callback) { db.ensureIndex('game', {'b':1}, callback); },          
    ], function(err, result) {
      if(err) throw err;
      // Assign the collections
      state.gameCollection = result[3];
      state.boardCollection = result[4];
  });

  // Fork workers (one pr. cpu), the web workers handle the websockets
  for (var i = 0; i < numCPUs; i++) {
    var worker = cluster.fork();
    worker.on('message', function(msg) {
      if(msg != null && msg['cmd'] == 'online') {
        console.log("============================================= worker online");
        console.dir(msg);
      }
    });    
  }  
  
  // If the worker thread dies just print it to the console and for a new one
  cluster.on('death', function(worker) {
    console.log('worker ' + worker.pid + ' died');
    cluster.fork();
  });
} else {
  // For each slave process let's start up a websocket server instance
  db.open(function(err, db) {
    db.admin().authenticate(dbUser, dbPassword, function(err, result) {
      if(err) throw err;
      if(!result) throw new Error("failed to authenticate with user = " + user);
      
      app.listen(port, function(err) {
        if(err) throw err;

        // Assign the collections
        state.gameCollection = db.collection('game');
        state.boardCollection = db.collection('board');

        // Websocket server
        var wsServer = new WebSocketServer({
          httpServer: app,    
          // Firefox 7 alpha has a bug that drops the
          // connection on large fragmented messages
          fragmentOutgoingMessages: false
        });  

        // A new connection from a player
        wsServer.on('request', function(request) {
          // Accept the connection
          var connection = request.accept('game', request.origin);
          // Add a connection counter id
          connection.connectionId = parseInt(format("%s%s", process.pid, connectionIdCounter++));
          // Save the connection to the current state
          state.connections[connection.connectionId] = connection;

          // Handle closed connections
          connection.on('close', function() {      
            cleanUpConnection(state, this);    
          });

          // Handle incoming messages
          connection.on('message', function(message) {
            // All basic communication messages are handled as JSON objects
            // That includes the request for status of the board.
            var self = this;
            // Handle game status messages
            if(message.type == 'utf8') {      
              // Decode the json message and take the appropriate action
              var messageObject = JSON.parse(message.utf8Data);
              // If initializing the game
              if(messageObject['type'] == 'initialize') {    
                initializeBoard(state, self);    
              } else if(messageObject['type'] == 'dead') {
                killBoard(state, self);
              } else if(messageObject['type'] == 'mongowin') {
                mongomanWon(state, self);
              } else if(messageObject['type'] == 'ghostdead') {
                ghostDead(state, self, messageObject);
              }
            } else if(message.type == 'binary') {
              // Binary message update player position
              state.gameCollection.update({id: self.connectionId}, message.binaryData);
              // Let's grab the record
              state.gameCollection.findOne({id: self.connectionId, state:'n'}, {raw:true}, function(err, rawDoc) {
                if(rawDoc) {
                  // Retrieve the board by id from cache
                  var boardId = state.boardIdByConnections[self.connectionId];                
                  var board = state.connectionsByBoardId[boardId];                
                  // Send the data to all the connections expect the originating connection
                  for(var i = 0; i < board.length; i++) {
                    if(board[i] != self.connectionId) {
                      if(state.connections[board[i]] != null) state.connections[board[i]].sendBytes(rawDoc);
                    }
                  }              
                }            
              });
            }
          });  
        });      
      });          
    });    
  })  
}

/**
 * A game was finished, let's remove the board from play by setting the number of users over 100
 * as remove does not carry any meaning in capped collections
 **/
var killBoard = function(_state, connection) {  
  _state.boardCollection.findAndModify({'players':connection.connectionId}, [], {
    $set: {number_of_players: 100}}, {new:true, upsert:false}, function(err, board) {      
      // Invalidate all the game records by setting them to dead
      _state.gameCollection.update({b:board._id}, {$set: {state:'d'}});      
      // Get the board id
      var boardId = _state.boardIdByConnections[connection.connectionId];
      // Get the connectionid list
      var connectionIds = _state.connectionsByBoardId[boardId];
      // Delete board to connection mapping
      delete _state.connectionsByBoardId[boardId];
      // Delete all mappings connections - board
      for(var j = 0; j < connectionIds.length; j++) {
        delete _state.boardIdByConnections[connectionIds[j]];
      }
      
      // Message all players that we are dead
      if(board != null) {
        for(var i = 0; i < board.players.length; i++) {
          // Send we are dead as well as intialize
          _state.connections[board.players[i]].sendUTF(JSON.stringify({state:'dead'}));
        }
      }      
    });
}

/**
 * This function creates a new board if there are not available, if there is a board available
 * for this process with less than 5 players add ourselves to it
 **/
var initializeBoard = function(_state, connection) {
  // Locate any boards with open spaces and add ourselves to it
  // using findAndModify to ensure we are the only one changing the board
  _state.boardCollection.findAndModify({number_of_players: {$lt:5}, pid: process.pid}, [], {
        $inc: {number_of_players: 1}, $push: {players:connection.connectionId}
      }, {new:true, upsert:false}, function(err, board) {        
    // If we have no board let's create one
    if(board == null) {
      // Create a new game board
      var newBoard = {
          _id: new ObjectID(),
          pid: process.pid,
          number_of_players: 1,
          players: [connection.connectionId, 0, 0, 0, 0]
        }
      // Ensure we cache the relationships between boards and connections
      if(_state.connectionsByBoardId[newBoard._id.id] == null) _state.connectionsByBoardId[newBoard._id.id] = [];
      _state.connectionsByBoardId[newBoard._id.id].push(connection.connectionId);
      _state.boardIdByConnections[connection.connectionId] = newBoard._id.id;
      // Save the board to the db, don't care about safe at this point as we don't need it yet
      _state.boardCollection.insert(newBoard);
      // Update the player array
      _state.boardCollection.update({_id:newBoard._id}, {$set:{players:[connection.connectionId]}});
      // Prime the board game with the monogman
      _state.gameCollection.insert({id:connection.connectionId, b:newBoard._id, role:'m', state:'n', pos:{x:0, y:0, accx:0, accy:0, facing:0, xpushing:0, ypushing:0}});
      // Signal the gamer we are mongoman
      connection.sendUTF(JSON.stringify({state:'initialize', isMongoman:true}));
    } else {
      // Ensure we cache the relationships between boards and connections
      if(_state.connectionsByBoardId[board._id.id] == null) _state.connectionsByBoardId[board._id.id] = [];
      _state.connectionsByBoardId[board._id.id].push(connection.connectionId);
      _state.boardIdByConnections[connection.connectionId] = board._id.id;
      // Prime the board game with the ghost
      _state.gameCollection.insert({id:connection.connectionId, b:board._id, role:'g', state:'n', pos:{x:0, y:0, accx:0, accy:0, facing:0, xpushing:0, ypushing:0}});
      // There is a board, we are a ghost, message the user that we are ready and also send the state of the board
      connection.sendUTF(JSON.stringify({state:'initialize', isMongoman:false}));
      // Find all board positions and send
      _state.gameCollection.find({b:board._id}, {raw:true}).toArray(function(err, docs) {
        if(!err) {
          for(var i = 0; i < docs.length; i++) {
            connection.sendBytes(docs[i]);
          }
        }
      });
    }
  })
}

/**
 * Remove the connection from our connection cache
 **/
var cleanUpConnection = function(_state, connection) {
  // Check if we have a connection
  if(_state.connections[connection.connectionId]) {
    delete _state.connections[connection.connectionId];
  }
}

/**
 * A ghost got eaten by mongoman, send the message to all other players
 **/
var ghostDead = function(_state, connection, message) {
  // Find the board the ghost died on
  state.boardCollection.findOne({'players': connection.connectionId}, function(err, board) {
    if(board) {
      // Send the ghost is dead to all other players on the board
      for(var i = 0; i < board.players.length; i++) {
        if(board.players[i] != connection.connectionId) {
          if(_state.connections[board.players[i]] != null) _state.connections[board.players[i]].sendUTF(JSON.stringify({state:'ghostdead', id:message.id}));
        }
      }                    
    }    
  });  
}

/**
 * Mongoman won by eating all the pills, send game over signal to all the other players
 **/
var mongomanWon = function(_state, connection) {
  // Set the board as dead
  _state.boardCollection.findAndModify({'players':connection.connectionId}, [], {
    $set: {number_of_players: 100}}, {new:true, upsert:false}, function(err, board) {
    // Send the ghost is dead to all other players on the board
    for(var i = 0; i < board.players.length; i++) {
      _state.connections[board.players[i]].sendUTF(JSON.stringify({state:'mongowin'}));
    }       
  });      
}



