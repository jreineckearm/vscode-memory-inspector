/********************************************************************************
 * Copyright (C) 2022 Ericsson, Arm and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { DebugProtocol } from '@vscode/debugprotocol';
import { sendRequest } from '../common/debug-requests';
import { stringToBytesMemory } from '../common/memory';
import { VariableRange } from '../common/memory-range';
import { ReadMemoryResult, WriteMemoryResult } from '../common/messaging';
import { MemoryDisplaySettingsContribution } from '../common/webview-configuration';
import { AdapterRegistry } from './adapter-registry/adapter-registry';
import { isSessionEvent, SessionTracker } from './session-tracker';

export class MemoryProvider {
    protected scheduledOnDidMemoryWriteEvents: { [sessionidmemoryReference: string]: ((response: WriteMemoryResult) => void) | undefined } = {};

    constructor(protected sessionId: string, protected adapterRegistry: AdapterRegistry, protected sessionTracker: SessionTracker) {
        this.sessionTracker.onSessionEvent(event => {
            if (isSessionEvent('memory-written', event) && event.session.raw.id === this.sessionId) {
                delete this.scheduledOnDidMemoryWriteEvents[event.session.raw.id + '_' + event.data.memoryReference];
            }
        });
    }

    public async readMemory(args: DebugProtocol.ReadMemoryArguments): Promise<ReadMemoryResult> {
        const session = this.sessionTracker.assertSession(this.sessionId);
        return sendRequest(this.sessionTracker.assertDebugCapability(session, 'supportsReadMemoryRequest', 'read memory'), 'readMemory', args);
    }

    public async writeMemory(args: DebugProtocol.WriteMemoryArguments): Promise<WriteMemoryResult> {
        const session = this.sessionTracker.assertDebugCapability(this.sessionTracker.assertSession(this.sessionId), 'supportsWriteMemoryRequest', 'write memory');
        // Schedule a emit in case we don't retrieve a memory event
        this.scheduledOnDidMemoryWriteEvents[session.id + '_' + args.memoryReference] = response => {
            // We only send out a custom event if we don't expect the client to handle the memory event
            // since our client is VS Code we can assume that they will always support this but better to be safe
            const offset = response?.offset ? (args.offset ?? 0) + response.offset : args.offset;
            const count = response?.bytesWritten ?? stringToBytesMemory(args.data).length;
            // if our custom handler is active, let's fire the event ourselves
            this.sessionTracker.fireSessionEvent(session, 'memory-written', { memoryReference: args.memoryReference, offset, count });
        };

        return sendRequest(session, 'writeMemory', args).then(response => {
            // The memory event is handled before we got here, if the scheduled event still exists, we need to handle it
            this.scheduledOnDidMemoryWriteEvents[session.id + '_' + args.memoryReference]?.(response);
            return response;
        });
    }

    public async getVariables(variableArguments: DebugProtocol.ReadMemoryArguments): Promise<VariableRange[]> {
        const session = this.sessionTracker.assertSession(this.sessionId, 'get variables');
        const handler = this.adapterRegistry?.getHandlerForSession(session.type);
        if (handler?.getResidents) { return handler.getResidents(session, variableArguments); }
        return handler?.getVariables?.(session) ?? [];
    }

    public async getAddressOfVariable(variableName: string): Promise<string | undefined> {
        const session = this.sessionTracker.assertSession(this.sessionId, 'get address of variable');
        const handler = this.adapterRegistry?.getHandlerForSession(session.type);
        return handler?.getAddressOfVariable?.(session, variableName);
    }

    public async getSizeOfVariable(variableName: string): Promise<bigint | undefined> {
        const session = this.sessionTracker.assertSession(this.sessionId, 'get size of variable');
        const handler = this.adapterRegistry?.getHandlerForSession(session.type);
        return handler?.getSizeOfVariable?.(session, variableName);
    }

    public async getMemoryDisplaySettingsContribution(): Promise<MemoryDisplaySettingsContribution> {
        const session = this.sessionTracker.assertSession(this.sessionId, 'get memory display settings contribution');
        const handler = this.adapterRegistry?.getHandlerForSession(session.type);
        return handler?.getMemoryDisplaySettings?.(session) ?? {};
    }
}
