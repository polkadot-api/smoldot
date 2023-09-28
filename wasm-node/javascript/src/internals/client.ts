// Smoldot
// Copyright (C) 2019-2022  Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Client, ClientOptions, QueueFullError, AlreadyDestroyedError, AddChainError, AddChainOptions, Chain, JsonRpcDisabledError, CrashError, SmoldotBytecode } from '../public-types.js';
import * as instance from './local-instance.js';
import * as remote from './remote-instance.js';

/**
 * Contains functions that the client will use when it needs to leverage the platform.
 */
export interface PlatformBindings {
    /**
     * Tries to open a new connection using the given configuration.
     *
     * @see Connection
     */
    connect(config: ConnectionConfig): Connection;

    /**
     * Returns the number of milliseconds since an arbitrary epoch.
     */
    performanceNow: () => number,

    /**
     * Fills the given buffer with randomly-generated bytes.
     */
    getRandomValues: (buffer: Uint8Array) => void,
}

/**
 * Connection to a remote node.
 *
 * At any time, a connection can be in one of the three following states:
 *
 * - `Opening` (initial state)
 * - `Open`
 * - `Reset`
 *
 * When in the `Opening` or `Open` state, the connection can transition to the `Reset` state
 * if the remote closes the connection or refuses the connection altogether. When that
 * happens, `config.onReset` is called. Once in the `Reset` state, the connection cannot
 * transition back to another state.
 *
 * Initially in the `Opening` state, the connection can transition to the `Open` state if the
 * remote accepts the connection. When that happens, `config.onOpen` is called.
 *
 * When in the `Open` state, the connection can receive messages. When a message is received,
 * `config.onMessage` is called.
 *
 * @see connect
 */
export interface Connection {
    /**
     * Transitions the connection or one of its substreams to the `Reset` state.
     *
     * If the connection is of type "single-stream", the whole connection must be shut down.
     * If the connection is of type "multi-stream", a `streamId` can be provided, in which case
     * only the given substream is shut down.
     *
     * The `config.onReset` or `config.onStreamReset` callbacks are **not** called.
     *
     * The transition is performed in the background.
     * If the whole connection is to be shut down, none of the callbacks passed to the `Config`
     * must be called again. If only a substream is shut down, the `onStreamReset` and `onMessage`
     * callbacks must not be called again with that substream.
     */
    reset(streamId?: number): void;

    /**
     * Queues data to be sent on the given connection.
     *
     * The connection and stream must currently be in the `Open` state.
     *
     * The number of bytes must never exceed the number of "writable bytes" of the stream.
     * `onWritableBytes` can be used in order to notify that more writable bytes are available.
     *
     * The `streamId` must be provided if and only if the connection is of type "multi-stream".
     * It indicates which substream to send the data on.
     *
     * Must not be called after `closeSend` has been called.
     */
    send(data: Uint8Array, streamId?: number): void;

    /**
     * Closes the writing side of the given stream of the given connection.
     *
     * Never called for connection types where this isn't possible to implement (i.e. WebSocket
     * and WebRTC at the moment).
     *
     * The connection and stream must currently be in the `Open` state.
     *
     * Implicitly sets the "writable bytes" of the stream to zero.
     *
     * The `streamId` must be provided if and only if the connection is of type "multi-stream".
     * It indicates which substream to send the data on.
     *
     * Must only be called once per stream.
     */
    closeSend(streamId?: number): void;

    /**
     * Start opening an additional outbound substream on the given connection.
     *
     * The state of the connection must be `Open`. This function must only be called for
     * connections of type "multi-stream".
     *
     * The `onStreamOpened` callback must later be called with an outbound direction.
     * 
     * Note that no mechanism exists in this API to handle the situation where a substream fails
     * to open, as this is not supposed to happen. If you need to handle such a situation, either
     * try again opening a substream again or reset the entire connection.
     */
    openOutSubstream(): void;
}

/**
 * Configuration for a connection.
 *
 * @see connect
 */
export interface ConnectionConfig {
    /**
     * Parsed multiaddress, as returned by the `parseMultiaddr` function.
     */
    address: instance.ParsedMultiaddr,

    /**
     * Callback called when the connection transitions from the `Opening` to the `Open` state.
     *
     * Must only be called once per connection.
     */
    onOpen: (info:
        {
            type: 'single-stream', handshake: 'multistream-select-noise-yamux',
            initialWritableBytes: number
        } |
        {
            type: 'multi-stream', handshake: 'webrtc',
            localTlsCertificateSha256: Uint8Array,
            remoteTlsCertificateSha256: Uint8Array,
        }
    ) => void;

    /**
     * Callback called when the connection transitions to the `Reset` state.
     *
     * It it **not** called if `Connection.reset` is manually called by the API user.
     */
    onConnectionReset: (message: string) => void;

    /**
     * Callback called when a new substream has been opened.
     *
     * This function must only be called for connections of type "multi-stream".
     */
    onStreamOpened: (streamId: number, direction: 'inbound' | 'outbound', initialWritableBytes: number) => void;

    /**
     * Callback called when a stream transitions to the `Reset` state.
     *
     * It it **not** called if `Connection.resetStream` is manually called by the API user.
     *
     * This function must only be called for connections of type "multi-stream".
     */
    onStreamReset: (streamId: number) => void;

    /**
     * Callback called when some data sent using {@link Connection.send} has effectively been
     * written on the stream, meaning that some buffer space is now free.
     *
     * Can only happen while the connection is in the `Open` state.
     *
     * This callback must not be called after `closeSend` has been called.
     *
     * The `streamId` parameter must be provided if and only if the connection is of type
     * "multi-stream".
     *
     * Only a number of bytes equal to the size of the data provided to {@link Connection.send}
     * must be reported. In other words, the `initialWritableBytes` must never be exceeded.
     */
    onWritableBytes: (numExtra: number, streamId?: number) => void;

    /**
     * Callback called when a message sent by the remote has been received.
     *
     * Can only happen while the connection is in the `Open` state.
     *
     * The `streamId` parameter must be provided if and only if the connection is of type
     * "multi-stream".
     */
    onMessage: (message: Uint8Array, streamId?: number) => void;
}

// This function is similar to the `start` function found in `index.ts`, except with an extra
// parameter containing the platform-specific bindings.
// Contrary to the one within `index.js`, this function is not supposed to be directly used.
export function start(options: ClientOptions, wasmModule: SmoldotBytecode | Promise<SmoldotBytecode>, platformBindings: PlatformBindings): Client {
    const logCallback = options.logCallback || ((level, target, message) => {
        // The first parameter of the methods of `console` has some printf-like substitution
        // capabilities. We don't really need to use this, but not using it means that the logs might
        // not get printed correctly if they contain `%`.
        if (level <= 1) {
            console.error("[%s] %s", target, message);
        } else if (level == 2) {
            console.warn("[%s] %s", target, message);
        } else if (level == 3) {
            console.info("[%s] %s", target, message);
        } else if (level == 4) {
            console.debug("[%s] %s", target, message);
        } else {
            console.trace("[%s] %s", target, message);
        }
    });

    if (!(wasmModule instanceof Promise)) {
        wasmModule = Promise.resolve(wasmModule);
    }

    // Extract (to make sure the value doesn't change) and sanitize `cpuRateLimit`.
    let cpuRateLimit = options.cpuRateLimit || 1.0;
    if (isNaN(cpuRateLimit)) cpuRateLimit = 1.0;
    if (cpuRateLimit > 1.0) cpuRateLimit = 1.0;
    if (cpuRateLimit < 0.0) cpuRateLimit = 0.0;

    // This object holds the state of everything.
    const state: {
        instance:
        { status: "not-created" } |
        { status: "not-ready", whenReady: Promise<void> } |
        { status: "ready", instance: instance.Instance } |
        { status: "destroyed", error: AlreadyDestroyedError | CrashError },
        // For each chain object returned by `addChain`, the associated internal chain id.
        // Immediately cleared when `remove()` is called on a chain.
        chainIds: WeakMap<Chain, number>,
        // List of all active connections. Keys are IDs assigned by the instance.
        connections: Map<number, Connection>,
        // FIFO queue. When `addChain` is called, an entry is added to this queue. When the
        // instance notifies that a chain creation has succeeded or failed, an entry is popped.
        addChainResults: Array<(outcome: { success: true, chainId: number } | { success: false, error: string }) => void>,
        /// Callback called when the `executor-shutdown` or `wasm-panic` event is received.
        onExecutorShutdownOrWasmPanic: () => void,
        // List of all active chains. Keys are chainIDs assigned by the instance.
        chains: Map<number, {
            // Callbacks woken up when a JSON-RPC response is ready or when the chain is destroyed
            // or when the instance crashes.
            jsonRpcResponsesPromises: (() => void)[],
        }>,
    } = {
        instance: { status: "not-created" },
        chainIds: new WeakMap(),
        connections: new Map(),
        addChainResults: [],
        onExecutorShutdownOrWasmPanic: () => {},
        chains: new Map(),
    };

    // Callback called during the execution of the instance.
    const eventCallback = (event: instance.Event) => {
        switch (event.ty) {
            case "wasm-panic": {
                console.error(
                    "Smoldot has panicked" +
                    (event.currentTask ? (" while executing task `" + event.currentTask + "`") : "") +
                    ". This is a bug in smoldot. Please open an issue at " +
                    "https://github.com/smol-dot/smoldot/issues with the following message:\n" +
                    event.message
                );

                state.instance = {
                    status: "destroyed",
                    error: new CrashError(event.message),
                }

                state.connections.forEach((connec) => connec.reset());
                state.connections.clear();

                for (const addChainResult of state.addChainResults) {
                    addChainResult({ success: false, error: "Smoldot has crashed" });
                }
                state.addChainResults = [];

                for (const chain of Array.from(state.chains.values())) {
                    for (const callback of chain.jsonRpcResponsesPromises) {
                        callback()
                    }
                    chain.jsonRpcResponsesPromises = [];
                }
                state.chains.clear();

                const cb = state.onExecutorShutdownOrWasmPanic;
                state.onExecutorShutdownOrWasmPanic = () => {};
                cb();
                break
            }
            case "executor-shutdown": {
                const cb = state.onExecutorShutdownOrWasmPanic;
                state.onExecutorShutdownOrWasmPanic = () => {};
                cb();
                break;
            }
            case "log": {
                logCallback(event.level, event.target, event.message)
                break;
            }
            case "add-chain-result": {
                (state.addChainResults.shift()!)(event);
                break;
            }
            case "json-rpc-responses-non-empty": {
                // Notify every single promise found in `jsonRpcResponsesPromises`.
                const callbacks = state.chains.get(event.chainId)!.jsonRpcResponsesPromises;
                while (callbacks.length !== 0) {
                    (callbacks.shift()!)();
                }
                break;
            }
            case "new-connection": {
                const connectionId = event.connectionId;
                state.connections.set(connectionId, platformBindings.connect({
                    address: event.address,
                    onConnectionReset(message) {
                        if (state.instance.status !== "ready")
                            throw new Error();
                        state.connections.delete(connectionId);
                        state.instance.instance.connectionReset(connectionId, message);
                    },
                    onMessage(message, streamId) {
                        if (state.instance.status !== "ready")
                            throw new Error();
                        state.instance.instance.streamMessage(connectionId, message, streamId);
                    },
                    onStreamOpened(streamId, direction, initialWritableBytes) {
                        if (state.instance.status !== "ready")
                            throw new Error();
                        state.instance.instance.streamOpened(connectionId, streamId, direction, initialWritableBytes);
                    },
                    onOpen(info) {
                        if (state.instance.status !== "ready")
                            throw new Error();
                        state.instance.instance.connectionOpened(connectionId, info);
                    },
                    onWritableBytes(numExtra, streamId) {
                        if (state.instance.status !== "ready")
                            throw new Error();
                        state.instance.instance.streamWritableBytes(connectionId, numExtra, streamId);
                    },
                    onStreamReset(streamId) {
                        if (state.instance.status !== "ready")
                            throw new Error();
                        state.instance.instance.streamReset(connectionId, streamId);
                    },
                }));
                break;
            }
            case "connection-reset": {
                const connection = state.connections.get(event.connectionId)!;
                connection.reset();
                state.connections.delete(event.connectionId);
                break;
            }
            case "connection-stream-open": {
                const connection = state.connections.get(event.connectionId)!;
                connection.openOutSubstream();
                break;
            }
            case "connection-stream-reset": {
                const connection = state.connections.get(event.connectionId)!;
                connection.reset(event.streamId);
                break;
            }
            case "stream-send": {
                const connection = state.connections.get(event.connectionId)!;
                connection.send(event.data, event.streamId);
                break;
            }
            case "stream-send-close": {
                const connection = state.connections.get(event.connectionId)!;
                connection.closeSend(event.streamId);
                break;
            }
        }
    };

    const portToWorker = options.portToWorker;
    if (!portToWorker) {
        // Start a local instance.
        state.instance = {
            status: "not-ready",
            whenReady: wasmModule
                .then((wasmModule) => {
                    return instance.startLocalInstance({
                        forbidTcp: options.forbidTcp || false,
                        forbidWs: options.forbidWs || false,
                        forbidNonLocalWs: options.forbidNonLocalWs || false,
                        forbidWss: options.forbidWss || false,
                        forbidWebRtc: options.forbidWebRtc || false,
                        maxLogLevel: options.maxLogLevel || 3,
                        cpuRateLimit,
                        envVars: [],
                        performanceNow: platformBindings.performanceNow,
                        getRandomValues: platformBindings.getRandomValues,
                    }, wasmModule.wasm, eventCallback)
                })
                .then((instance) => {
                    // The Wasm instance might have been crashed before this callback is called.
                    if (state.instance.status === "destroyed")
                        return;
                    state.instance = {
                        status: "ready",
                        instance,
                    };
                })
        };
    } else {
        // Connect to the remote instance.
        state.instance = {
            status: "not-ready",
            whenReady: remote.connectToInstanceServer({
                wasmModule: wasmModule.then((b) => b.wasm),
                forbidTcp: options.forbidTcp || false,
                forbidWs: options.forbidWs || false,
                forbidNonLocalWs: options.forbidNonLocalWs || false,
                forbidWss: options.forbidWss || false,
                forbidWebRtc: options.forbidWebRtc || false,
                maxLogLevel: options.maxLogLevel || 3,
                cpuRateLimit,
                portToServer: portToWorker,
                eventCallback
            }).then((instance) => {
                    // The Wasm instance might have been crashed before this callback is called.
                    if (state.instance.status === "destroyed")
                        return;
                    state.instance = {
                        status: "ready",
                        instance,
                    };
                })
        };
    }

    return {
        addChain: async (options: AddChainOptions): Promise<Chain> => {
            if (state.instance.status === "not-ready")
                await state.instance.whenReady;
            if (state.instance.status === "destroyed")
                throw state.instance.error;

            if (state.instance.status === "not-created" || state.instance.status === "not-ready")
                throw new Error();  // Internal error, not supposed to ever happen.

            // Passing a JSON object for the chain spec is an easy mistake, so we provide a more
            // readable error.
            if (!(typeof options.chainSpec === 'string'))
                throw new Error("Chain specification must be a string");

            let potentialRelayChainsIds = [];
            if (!!options.potentialRelayChains) {
                for (const chain of options.potentialRelayChains) {
                    // The content of `options.potentialRelayChains` are supposed to be chains earlier
                    // returned by `addChain`.
                    const id = state.chainIds.get(chain);
                    if (id === undefined) // It is possible for `id` to be missing if it has earlier been removed.
                        continue;
                    potentialRelayChainsIds.push(id);
                }
            }

            // Sanitize `jsonRpcMaxPendingRequests`.
            let jsonRpcMaxPendingRequests = options.jsonRpcMaxPendingRequests === undefined ? Infinity : options.jsonRpcMaxPendingRequests;
            jsonRpcMaxPendingRequests = Math.floor(jsonRpcMaxPendingRequests);
            if (jsonRpcMaxPendingRequests <= 0 || isNaN(jsonRpcMaxPendingRequests)) {
                throw new AddChainError("Invalid value for `jsonRpcMaxPendingRequests`");
            }
            if (jsonRpcMaxPendingRequests > 0xffffffff) {
                jsonRpcMaxPendingRequests = 0xffffffff
            }

            // Sanitize `jsonRpcMaxSubscriptions`.
            let jsonRpcMaxSubscriptions = options.jsonRpcMaxSubscriptions === undefined ? Infinity : options.jsonRpcMaxSubscriptions;
            jsonRpcMaxSubscriptions = Math.floor(jsonRpcMaxSubscriptions);
            if (jsonRpcMaxSubscriptions < 0 || isNaN(jsonRpcMaxSubscriptions)) {
                throw new AddChainError("Invalid value for `jsonRpcMaxSubscriptions`");
            }
            if (jsonRpcMaxSubscriptions > 0xffffffff) {
                jsonRpcMaxSubscriptions = 0xffffffff
            }

            // Sanitize `databaseContent`.
            if (options.databaseContent !== undefined && typeof options.databaseContent !== 'string')
                throw new AddChainError("`databaseContent` is not a string");

            const promise = new Promise<{ success: true, chainId: number } | { success: false, error: string }>((resolve) => state.addChainResults.push(resolve));

            state.instance.instance.addChain(
                options.chainSpec,
                options.databaseContent || "",
                potentialRelayChainsIds,
                !!options.disableJsonRpc,
                jsonRpcMaxPendingRequests,
                jsonRpcMaxSubscriptions
            );

            const outcome = await promise;
            if (!outcome.success)
                throw new AddChainError(outcome.error);

            const chainId = outcome.chainId;

            state.chains.set(chainId, {
                jsonRpcResponsesPromises: new Array()
            });

            const newChain: Chain = {
                sendJsonRpc: (request) => {
                    if (state.instance.status === "destroyed")
                        throw state.instance.error;
                    if (state.instance.status !== "ready")
                        throw new Error(); // Internal error. Never supposed to happen.
                    if (!state.chains.has(chainId))
                        throw new AlreadyDestroyedError();
                    if (options.disableJsonRpc)
                        throw new JsonRpcDisabledError();

                    const retVal = state.instance.instance.request(request, chainId);
                    switch (retVal) {
                        case 0: break;
                        case 1: throw new QueueFullError();
                        default: throw new Error("Internal error: unknown json_rpc_send error code: " + retVal)
                    }
                },
                nextJsonRpcResponse: async () => {
                    while (true) {
                        if (!state.chains.has(chainId))
                            throw new AlreadyDestroyedError();
                        if (options.disableJsonRpc)
                            return Promise.reject(new JsonRpcDisabledError());
                        if (state.instance.status === "destroyed")
                            throw state.instance.error;
                        if (state.instance.status !== "ready")
                            throw new Error(); // Internal error. Never supposed to happen.

                        // Try to pop a message from the queue.
                        const message = state.instance.instance.peekJsonRpcResponse(chainId);
                        if (message)
                            return message;

                        // If no message is available, wait for one to be.
                        await new Promise<void>((resolve) => {
                            state.chains.get(chainId)!.jsonRpcResponsesPromises.push(resolve)
                        });
                    }
                },
                remove: () => {
                    if (state.instance.status === "destroyed")
                        throw state.instance.error;
                    if (state.instance.status !== "ready")
                        throw new Error(); // Internal error. Never supposed to happen.
                    if (!state.chains.has(chainId))
                        throw new AlreadyDestroyedError();
                    console.assert(state.chainIds.has(newChain));
                    state.chainIds.delete(newChain);
                    for (const callback of state.chains.get(chainId)!.jsonRpcResponsesPromises) {
                        callback();
                    }
                    state.chains.delete(chainId);
                    state.instance.instance.removeChain(chainId);
                },
            };

            state.chainIds.set(newChain, chainId);
            return newChain;
        },
        terminate: async () => {
            if (state.instance.status === "not-ready")
                await state.instance.whenReady;
            if (state.instance.status === "destroyed")
                throw state.instance.error;
            if (state.instance.status !== "ready")
                throw new Error(); // Internal error. Never supposed to happen.
            state.instance.instance.shutdownExecutor();

            // Wait for the `executor-shutdown` event to be generated.
            await new Promise<void>((resolve) => state.onExecutorShutdownOrWasmPanic = resolve);

            // In case the instance crashes while we were waiting, we don't want to overwrite
            // the error.
            if (state.instance.status === "ready")
                state.instance = { status: "destroyed", error: new AlreadyDestroyedError() };
            state.connections.forEach((connec) => connec.reset());
            state.connections.clear();
            for (const addChainResult of state.addChainResults) {
                addChainResult({ success: false, error: "Client.terminate() has been called" });
            }
            state.addChainResults = [];
            for (const chain of Array.from(state.chains.values())) {
                for (const callback of chain.jsonRpcResponsesPromises) {
                    callback()
                }
                chain.jsonRpcResponsesPromises = [];
            }
            state.chains.clear();
        }
    }
}
