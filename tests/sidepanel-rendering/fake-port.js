export function createFakePortController(options = {}) {
  const connections = [];
  let connectCount = 0;
  let postCount = 0;

  function connect() {
    connectCount += 1;
    if (typeof options.failConnect === "function" && options.failConnect(connectCount)) {
      throw new Error(`fake connect failure ${connectCount}`);
    }
    const onMessage = createFakeEvent();
    const onDisconnect = createFakeEvent();
    const sent = [];
    let disconnected = false;
    const port = {
      onMessage,
      onDisconnect,
      postMessage(message) {
        if (disconnected) throw new Error("fake port disconnected");
        postCount += 1;
        if (typeof options.failPostMessage === "function" && options.failPostMessage(message, {
          connectCount,
          postCount,
        })) {
          throw new Error(`fake post failure ${postCount}`);
        }
        sent.push(clone(message));
        options.onPostMessage?.(message, connection);
      },
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        onDisconnect.emit();
      },
    };
    const connection = {
      port,
      sent,
      emit(message) {
        if (!disconnected) onMessage.emit(clone(message));
      },
      disconnect() {
        port.disconnect();
      },
      get disconnected() {
        return disconnected;
      },
      get listenerCounts() {
        return { message: onMessage.size, disconnect: onDisconnect.size };
      },
    };
    connections.push(connection);
    return port;
  }

  return {
    connect,
    connections,
    get current() {
      return connections[connections.length - 1] || null;
    },
    get connectCount() {
      return connectCount;
    },
    get postCount() {
      return postCount;
    },
  };
}

export function createFakeEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
