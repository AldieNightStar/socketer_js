const wsocketer = {};

(() => {
    wsocketer.newClient = function(url, password, name, options) {
        return new Promise((resolve, reject) => {
            let ws = new WebSocket(url);
            let state = 0;
            let messageReceivers = [];
            addSendAwait(ws);

            // Create client and create special object for it
            let spec = {
                ws,
                disconnected: false,
                reconnectedClient: null
            }
            let client = _client(name, spec, options, messageReceivers);

            /**
             * Reconnects client. Writes in "spec.reconnectedClient" new client. So then client have to delegate all the calls to it
             */
            async function reconnect() {
                let rclient = await wsocketer.newClient(url, password, name, {
                    ...options,
                    onConnect: () => {
                        spec.disconnected = false;
                        if (options.onConnect) {
                            options.onConnect();
                        }
                    },
                    onDisconnect: async () => {
                        spec.disconnected = true;
                        if (options.onDisconnect) {
                            options.onDisconnect();
                        }
                        spec.reconnectedClient = await reconnect();
                    },
                    autoReconnect: false
                });
                return rclient;
            }

            ws.addEventListener("open", async () => {
                if (state === 0) {
                    let resp = await ws.sendAwait(password);
                    if (resp !== "AUTH OK") {
                        reject(new Error("Wrong password!"));
                        return;
                    }
                    resp = await ws.sendAwait(name);
                    if (resp !== "NAME OK") {
                        reject(new Error("Wrong name: " + resp));
                        return;
                    }
                    state = 1;
                    if (options.onConnect) {
                        options.onConnect(client);
                    }
                    resolve(client);
                }
            });
            ws.addEventListener("close", async () => {
                if (options.onDisconnect) {
                    spec.disconnected = true;
                    ws.close();
                    if (options.onDisconnect) options.onDisconnect();
                    if (options.autoReconnect) {
                        if (spec.disconnectedManually) {
                            delete spec.disconnectedManually;
                        } else {
                            spec.reconnectedClient = await reconnect();
                        }
                    }
                }
            });
            ws.addEventListener('message', async msgEvt => {
                let msg = msgEvt.data;
                if (state === 1) {
                    let [sender, message] = splitWithTail(msg, " ", 1);
                    message = JSON.parse(message);

                    // Check each function in messageReceivers. If some function will return true, then we will remove it from array
                    //   and stop the iteration
                    // Each message should have message.identifier filter. And if filter is right, then this message returns true and we remove it.
                    let newMessage = true;
                    for (let i = 0; i < messageReceivers.length; i++) {
                        let func = messageReceivers[i];
                        if (func(message)) {
                            let funcId = messageReceivers.indexOf(func);
                            messageReceivers.splice(funcId, 1);
                            newMessage = false;
                            break;
                        }
                    }

                    // If no-one message returned true, then we said that this message is new for client.
                    // We consider it as new message
                    if (options.onMessage && newMessage) {
                        let answ = await options.onMessage(sender, message.data);
                        if (answ !== undefined) {
                            answ = composeAnswerObject(message.identifier, answ);
                            let answText = JSON.stringify(answ);
                            ws.send(`SEND ${sender} ${answText}`);
                        } else {
                            answ = composeAnswerObject(message.identifier, "ERR_NODATA");
                            let asnwText = JSON.stringify(answ);
                            ws.send(`SEND ${sender} ${asnwText}`);
                        }
                    }
                }
            });
        });
    }

    function _client(name, spec, options, messageReceivers) {
        function formatMsg(name, msg) {
            return "SEND " + name + " " + msg;
        }

        async function send(name, messageData) {
            // If client reconnected, then we have copy of that client,
            // which is running inside our "spec" object.
            // Delegate send call to this client
            if (spec.reconnectedClient !== null) {
                return await spec.reconnectedClient.send(...arguments);
            }

            let msgObject = composeMessageObject(name, messageData);

            // Put new CallBack to messageReceivePromise which will resolve promise to await for message with the same identifier
            let messageReceivePromise = new Promise(ok => {
                let func = incomeMessage => {
                    try {
                        // Try to read message and if identifier is ok then return message data. Or null if identifiers are not equal
                        let data = readAnswerMessage(msgObject.identifier, incomeMessage)
                        if (data !== null && data !== undefined) {
                            ok(data);
                            return true;
                        }
                        return false;
                    } catch (e) {
                        console.error(e);
                        return false;
                    }
                };
                messageReceivers.push(func);

                // Remove this function from array if no response for so long
                setTimeout(() => {
                    let funcId = messageReceivers.indexOf(func);
                    if (funcId !== -1) {
                        messageReceivers.splice(funcId, 1);
                    }
                }, 10000);
            })

            let formatedMessage = formatMsg(name, JSON.stringify(msgObject))
            if (formatedMessage.length > 1024 * 128) throw new Error("Message is too big!");
            spec.ws.send(formatedMessage);

            let resp = await awaitOrTimeout(messageReceivePromise, 9000);
            if (resp === null) throw new Error("Response time out!");
            if (resp === "ERR_NOCLIENT") throw new Error(`Client with name "${name}" is not connected for now!`);
            if (resp === "ERR_NODATA") return null;

            return resp;
        }
        async function disconnect() {
            spec.disconnectedManually = true;
            if (spec.reconnectedClient) {
                await spec.reconnectedClient.disconnect();
                spec.reconnectedClient = null;
                return;
            }
            if (spec.disconnected) return;
            spec.disconnected = true;
            spec.ws.close();
        }
        async function getOthers() {
            if (spec.reconnectedClient) {
                return await spec.reconnectedClient.getOthers();
            }
            let resp = await send("SERVER", "NAMES");
            if (resp === undefined || resp === null) throw Error("Can't retreive list of clients.");
            if (!Array.isArray(resp)) throw Error("Error with retreiving list of clients: " + resp);
            { // Remove myself from this list
                let myid = resp.indexOf(name);
                if (myid !== -1) {
                    resp.splice(myid, 1);
                }
            }
            return resp;
        }

        return { send, disconnect, options, getOthers };
    }


    function splitWithTail(str, delim, count) {
        var parts = str.split(delim);
        var tail = parts.slice(count).join(delim);
        var result = parts.slice(0, count);
        result.push(tail);
        return result;
    }

    function awaitOrTimeout(promise, ms) {
        let timer = new Promise(ok => setTimeout(() => ok(null), ms));
        return Promise.race([promise, timer]);
    }

    function addSendAwait(ws) {
        ws.sendAwait = function(message) {
            return new Promise((resolve, reject) => {
                ws.addEventListener('message', function listener(evt) {
                    resolve(evt.data);
                    ws.removeEventListener("message", listener);
                });
                ws.send(message);
            });
        }
    }
    // =======================================
    //   Message code
    // =======================================

    function composeMessageObject(clientName, data) {
        let rnd = Math.floor(Math.random() * 9000) + 1000
        let code = `${clientName}_${rnd}_${Date.now()}`;
        return {
            "identifier": code,
            "data": data
        }
    }

    function composeAnswerObject(identifier, data) {
        return { identifier, data };
    }

    function readAnswerMessage(identifier, msg) {
        if (typeof (msg) !== "object") return null;
        if (msg.identifier !== identifier) return null;
        return msg.data;
    }
})();