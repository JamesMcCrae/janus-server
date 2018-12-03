var args = require('optimist').argv;
var byline = require('byline');
var config = require(args.config || '../config.js');

function Session(server, socket) {

    var self = this;

    this._socket = socket;

    this._userLocked = false;
    this._authed = false;

    this._server = server;
    this._rooms = [];
    this._usernames = [];

    this.id = null;
    this.currentRoom = null;


    byline(socket).on('data', this.parseMessage.bind(this));

};


module.exports = Session;

Session.prototype.close = function() {
    console.log("close called on session");
    delete this._server._userList[this.id];
    delete this._server._partyList[this.id];
    this._server.savePartyList();
    if ( this.currentRoom ) {
        this.currentRoom.emit('user_disconnected', { userId:this.id });
    }
    this._rooms.forEach(function(room) {
        room.removeSession(this);
    });
}

Session.prototype.send = function(method, data) {
    var packet = JSON.stringify({method:method,data:data});
    if (!this._socket.destroyed)
        this._socket.write(packet+'\r\n');
    //log.info('S->C: ' + packet);
};

Session.prototype.clientError = function(message) {
    log.error('Client error ('+this._socket.remoteAddress + ', ' + (this.id || 'Unnamed') + '): ' + message);
    this.send('error', {message:message});
};

Session.validMethods = [
    'logon', 
    'subscribe', 
    'unsubscribe', 
    'enter_room', 
    'move', 
    'chat', 
    'portal', 
    'users_online',
    'get_partylist',
];

    Session.prototype.parseMessage = function(data) {

        //log.info('C->S: ' + data);

        var payload;
        var self = this;

        try {
            payload = JSON.parse(data);
        } catch(e) {
            log.info("data: " + data);
            log.info("payload: " + payload);
            this.clientError('Unable to parse last message');
            return;
        }
        if(Session.validMethods.indexOf(payload.method) === -1) {
            this.clientError('Invalid method: ' + payload.method);
            return;
        }

        if(payload.method !== 'logon' && !this._authed ) {
            this.clientError('You must call "logon" before sending any other commands.');
            return;
        }

        if(payload.data === undefined) payload.data = {};
        if(typeof(payload.data)!= "object") payload.data = { "data": payload.data };
        payload.data._userId = this.id;
        payload.data._userList = this._server._userList;
        payload.data._roomEmit = function(method, data) { self.currentRoom.emit(method, data) };
        Session.prototype[payload.method].call(this,payload.data);
    };




/*************************************************************************/
/*  Client methods                                                       */
/*************************************************************************/


// ## User Logon ##
Session.prototype.logon = function(data) {
    if(typeof data.userId !== "string" || data.userId === '') {
        this.clientError('Missing userId in data packet');
        return;
    }
    if (!data.userId.match('^[a-zA-Z0-9_]+$')) {
        this.clientError('illegal character in user name, only use alphanumeric and underscore');
        return;
    }

    if(data.roomId === undefined) {
        this.clientError('Missing roomId in data packet');
        return;
    }

    if(!this._server.isNameFree(data.userId)) {
        this.clientError('User name is already in use');
        return;
    }

    this._server._plugins.call("logon", this, data);

    this.id = data.userId;
    this._authed = true;
    this.client_version = 
            (data.version === undefined)?"undefined":data.version;
    
    var self = this;
    this._server._userList[data.userId] = {
        roomId: data.roomId,
        send: function(method, data) { self.send(method, data); }
    }

    log.info('User: ' + this.id + ' signed on');
    this.currentRoom = this._server.getRoom(data.roomId);
    setTimeout(function(){ 
        if (!self._socket.destroyed)
            self.subscribe(data); 
    }, 500);
};

// ## user enter room ##
Session.prototype.enter_room = function(data) {
    if(data.roomId  === undefined) {
        this.clientError('Missing roomId in data packet');
        return;
    }

    var oldRoomId = null;
    if(this.currentRoom) {
        oldRoomId = this.currentRoom.id;
        this.currentRoom.emit('user_leave', { 
            userId: this.id, 
            roomId: this.currentRoom.id,
            newRoomId: data.roomId
        });
    }
    this._server._plugins.call("enter_room", data);
    
    this._server._userList[this.id].oldRoomId = oldRoomId;
    this._server._userList[this.id].roomId = data.roomId;
    if ((data.partyMode == true) || (data.partyMode == "true")) {
        if (this._server._partyList[this.id] === undefined) {
            this._server._partyList[this.id] = {};
       
        }
        if ((data.roomUrl !== undefined) && (data.roomUrl.match('^https?://') || data.roomUrl == '')){   
            this._server._partyList[this.id].roomId = data.roomId;    
            this._server._partyList[this.id].roomUrl = data.roomUrl;    
            this._server._partyList[this.id].roomName = (data.roomName === undefined) ? "" : data.roomName;   
            this._server._partyList[this.id].client_version = this.client_version;    
        }           
    } else {
         delete this._server._partyList[this.id];       
    }
    this._server.savePartyList();    
    this.currentRoom = this._server.getRoom(data.roomId);
    this.currentRoom.emit('user_enter', { 
        userId: this.id, 
        roomId: data.roomId,
        oldRoomId: oldRoomId
    });
};


// ## user move ##
Session.prototype.move = function(position) {

    var data = {
        roomId: this.currentRoom.id,
        userId: this.id,
        position: position
    };

    this.currentRoom.emit('user_moved', data);
};


// ## user chat ##
Session.prototype.chat = function(message) {

    var data = {
        roomId: this.currentRoom.id,
        userId: this.id,
        message: message
    };

    this.currentRoom.emit('user_chat', data);
};

Session.prototype.subscribe = function(data) {

    if(data.roomId  === undefined) {
        this.clientError('Missing roomId in data packet');
        return;
    }

    var room = this._server.getRoom(data.roomId);

    if(this._rooms.indexOf(room) === -1) {
        room.addSession(this);
        this._rooms.push(room);
    }

    this.send('okay');
};

Session.prototype.unsubscribe = function(data) {

    if(data.roomId  === undefined) {
        this.clientError('Missing roomId in data packet');
        return;
    }

    var room = this._server.getRoom(data.roomId);
    var i = this._rooms.indexOf(room);
    if(i !== -1) {
        room.removeSession(this);
        this._rooms.splice(i,1);
    }
    if (room.isEmpty()) {
        delete this._server._rooms[data.roomId]; 
    }
    this.send('okay');
};


Session.prototype.portal = function(portal) {

    //TODO: Persist portals

    var data = {
        roomId: this.currentRoom.id,
        userId: this.id,
        url: portal.url,
        pos: portal.pos,
        fwd: portal.fwd
    };

    this.currentRoom.emit('user_portal', data);
    this.send('okay');
};

Session.prototype.users_online = function(data) {
    var maxResults = config.maxUserResults;
    var count = 0;
    var results = Array();

    if(data.maxResults !== undefined && data.maxResults < maxResults) maxResults = data.maxResults;

    if(data.roomId === undefined) {
        for(k in this._server._userList) {
            results.push(k);
            count++;
            if(count >= maxResults) break;
        }
    }
    else {
        for(k in this._server._userList) {
            if(this._server._userList[k].roomId == data.roomId) {
                results.push([k]);
                count++;
                if(count >= maxResults) break;
            }
        }
    }

    json = { "results": count, "roomId": data.roomId, "users": results };
    this.send('users_online', json);
}

Session.prototype.get_partylist = function(data) {
    this.send('get_partylist', this._server._partyList);
}
