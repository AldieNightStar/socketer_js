# JS WS - Socketer JS

# Install
```html

```

# Client
```js
// Can throw Error when name is busy or password is incorrect
let client = await wsocketer.newClient("ws://localhost:8080", "MyPassword", "MyName", {
    onConnect: () => console.log("Connected!"),
    onDisconnect: () => console.log("Discconnected!"),

    // Тут коли приходить повідомлення від іншого клієнта
    onMessage: (sender, message) => {
        // sender - Caller name
        // message - Message (string | object)

        // Response to caller
        return { "echo": message }
    }
});
```

```js
// Send message to "Service1"
// Can throw caller if caller is absent, etc. Better to use try/catch
// response - can be (string | object)
let response = await client.send("Service1", {a: 1, b: 2})

// Get other clients list (Your client name will be skipped)
let list = await client.getOthers();

// Close client
await client.disconnect();
```