import { logger } from "@/lib";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "../sdk";
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from "../sdk/prompts";
import { Session } from "../session";
import { startPermissionServerV2 } from "./startPermissionServerV2";
import { deepEqual } from "@/utils/deepEqual";

export async function startPermissionResolver(session: Session) {

    let toolCalls: { id: string, name: string, input: any, used: boolean }[] = [];

    let responses = new Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>();
    let requests = new Map<string, (response: { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }) => void>();
    
    // Queue for permission requests that arrive before their tool call ID
    let pendingPermissionRequests: Array<{
        request: { name: string, arguments: any },
        resolve: (value: { approved: boolean, reason?: string }) => void,
        reject: (error: Error) => void,
        timeout: NodeJS.Timeout
    }> = [];
    
    const server = await startPermissionServerV2(async (request) => {

        const id = resolveToolCallId(request.name, request.arguments);
        if (!id) {
            // Tool call ID hasn't arrived yet - queue this request
            logger.debug(`Tool call ID not yet available for ${request.name}, queueing request`);
            
            return new Promise<{ approved: boolean, reason?: string }>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    const idx = pendingPermissionRequests.findIndex(p => p.request === request);
                    if (idx !== -1) {
                        pendingPermissionRequests.splice(idx, 1);
                        reject(new Error(`Timeout: Tool call ID never arrived for ${request.name}`));
                    }
                }, 30000); // 30 second timeout
                
                pendingPermissionRequests.push({ request, resolve, reject, timeout });
            });
        }

        return handlePermissionRequest(id, request);
    });
    
    function handlePermissionRequest(id: string, request: { name: string, arguments: any }): Promise<{ approved: boolean, reason?: string }> {
        // Hack for exit_plan_mode
        let promise = new Promise<{ approved: boolean, reason?: string }>((resolve) => {
            if (request.name === 'exit_plan_mode' || request.name === 'ExitPlanMode') {
                // Intercept exit_plan_mode approval
                const wrappedResolve = (response: { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }) => {
                    if (response.approved) {
                        logger.debug('Plan approved - injecting PLAN_FAKE_RESTART');
                        // Inject the approval message at the beginning of the queue
                        if (response.mode && ['default', 'acceptEdits', 'bypassPermissions'].includes(response.mode)) {
                            session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: response.mode });
                        } else {
                            session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: 'default' });
                        }
                        resolve({ approved: false, reason: PLAN_FAKE_REJECT });
                    } else {
                        resolve(response);
                    }
                };
                requests.set(id, wrappedResolve);
            } else {
                requests.set(id, resolve);
            }
        });

        let timeout = setTimeout(async () => {
            // Interrupt claude execution on permission timeout
            logger.debug('Permission timeout - attempting to interrupt Claude');
            // const interrupted = await interruptController.interrupt();
            // if (interrupted) {
            //     logger.debug('Claude interrupted successfully');
            // }

            // Delete callback we are awaiting on
            requests.delete(id);

            // Move the permission request to completedRequests with canceled status
            session.client.updateAgentState((currentState) => {
                const request = currentState.requests?.[id];
                if (!request) return currentState;

                let r = { ...currentState.requests };
                delete r[id];

                return ({
                    ...currentState,
                    requests: r,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: 'canceled',
                            reason: 'Timeout'
                        }
                    }
                });
            });
        }, 1000 * 60 * 4.5) // 4.5 minutes, 30 seconds before max timeout
        logger.debug('Permission request' + id + ' ' + JSON.stringify(request));

        // Send push notification for permission request
        session.pushClient.sendToAllDevices(
            'Permission Request',
            `Claude wants to use ${request.name}`,
            {
                sessionId: session.client.sessionId,
                requestId: id,
                tool: request.name,
                type: 'permission_request'
            }
        );

        session.client.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [id]: {
                    tool: request.name,
                    arguments: request.arguments,
                    createdAt: Date.now()
                }
            }
        }));

        // Clear timeout when permission is resolved
        promise.then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));

        return promise;
    }

    session.client.setHandler<PermissionResponse, void>('permission', async (message) => {
        logger.debug('Permission response' + JSON.stringify(message));
        const id = message.id;
        const resolve = requests.get(id);
        if (resolve) {
            responses.set(id, message);
            resolve({ approved: message.approved, reason: message.reason, mode: message.mode });
            requests.delete(id);
        } else {
            logger.debug('Permission request stale, likely timed out');
            return;
        }

        // Move processed request to completedRequests
        session.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;

            let r = { ...currentState.requests };
            delete r[id];

            // Check for PLAN_FAKE_REJECT to report as success
            const isExitPlanModeSuccess = request.tool === 'exit_plan_mode' &&
                !message.approved &&
                message.reason === PLAN_FAKE_REJECT;

            return ({
                ...currentState,
                requests: r,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: isExitPlanModeSuccess ? 'approved' : (message.approved ? 'approved' : 'denied'),
                        reason: isExitPlanModeSuccess ? 'Plan approved' : message.reason
                    }
                }
            });
        });
    });

    const resolveToolCallId = (name: string, args: any): string | null => {
        // Search in reverse (most recent first)
        for (let i = toolCalls.length - 1; i >= 0; i--) {
            const call = toolCalls[i];
            if (call.name === name && deepEqual(call.input, args)) {
                if (call.used) {
                    return null;
                }
                // Found unused match - mark as used and return
                call.used = true;
                return call.id;
            }
        }

        // No match found
        return null;
    };

    function reset() {
        toolCalls = [];
        requests.clear();
        responses.clear();
        
        // Clear pending permission requests
        for (const pending of pendingPermissionRequests) {
            clearTimeout(pending.timeout);
        }
        pendingPermissionRequests = [];

        // Move all pending requests to completedRequests with canceled status
        session.client.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move each pending request to completed with canceled status
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session switched to local mode'
                };
            }

            return {
                ...currentState,
                requests: {}, // Clear all pending requests
                completedRequests
            };
        });
    }

    function onMessage(message: SDKMessage) {
        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id!,
                            name: block.name!,
                            input: block.input,
                            used: false
                        });
                        
                        // Process any pending permission requests that match this tool call
                        for (let i = pendingPermissionRequests.length - 1; i >= 0; i--) {
                            const pending = pendingPermissionRequests[i];
                            if (pending.request.name === block.name && deepEqual(pending.request.arguments, block.input)) {
                                logger.debug(`Resolving pending permission request for ${block.name} with ID ${block.id}`);
                                clearTimeout(pending.timeout);
                                pendingPermissionRequests.splice(i, 1);
                                
                                // Process the request now that we have the ID
                                handlePermissionRequest(block.id!, pending.request).then(
                                    pending.resolve,
                                    pending.reject
                                );
                                break; // Exit after finding the first match
                            }
                        }
                    }
                }
            }
        }
        if (message.type === 'user') {
            const userMsg = message as SDKUserMessage;

            // Check content for tool_result blocks
            if (userMsg.message && userMsg.message.content && Array.isArray(userMsg.message.content)) {
                for (const block of userMsg.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const toolCall = toolCalls.find(tc => tc.id === block.tool_use_id);
                        if (toolCall && !toolCall.used) {
                            toolCall.used = true;
                        }
                    }
                }
            }
        }
    }

    return {
        server,
        reset,
        onMessage,
        responses
    }
}

interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}