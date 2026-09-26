import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// Minimal penpot global mock (must exist before the handler module is loaded)
// ---------------------------------------------------------------------------

const sentMessages: any[] = [];

const penpotMock = {
    flags: { naturalChildOrdering: false, throwValidationErrors: false },
    ui: {
        sendMessage: (message: any) => {
            sentMessages.push(message);
        },
    },
};
(globalThis as any).penpot = penpotMock;

const { ExecuteCodeTaskHandler } = await import("./task-handlers/ExecuteCodeTaskHandler.ts");
const { Task } = await import("./TaskHandler.ts");

/**
 * Resets the plugin flags to their values outside of code execution.
 */
function resetFlags(): void {
    penpotMock.flags.naturalChildOrdering = false;
    penpotMock.flags.throwValidationErrors = false;
}

/**
 * Runs the given code through the handler and returns the response data sent back for it.
 */
async function run(handler: InstanceType<typeof ExecuteCodeTaskHandler>, id: string, code: string) {
    await handler.handle(new Task(id, "executeCode", { code }));
    return responseData(id);
}

/**
 * Returns the response data the handler sent for the task with the given id.
 */
function responseData(id: string): { result: any; log: string } {
    const message = sentMessages.find((m) => m.response.id === id);
    assert.ok(message, `no response sent for task ${id}`);
    return message.response.data;
}

/**
 * Runs two executions that overlap in time: A starts first, B starts while A is still
 * awaiting, and A finishes before B. B returns the flag values it observes after A finished.
 */
async function runOverlapping() {
    resetFlags();
    const handler = new ExecuteCodeTaskHandler();

    // gates that let the test decide when each execution finishes
    const storage = (
        await run(
            handler,
            "setup",
            "storage.gateA = new Promise((r) => (storage.releaseA = r));" +
                "storage.gateB = new Promise((r) => (storage.releaseB = r));" +
                "return storage;"
        )
    ).result;

    const runA = handler.handle(
        new Task("A", "executeCode", { code: `console.log("from A"); await storage.gateA; return "A";` })
    );
    const runB = handler.handle(
        new Task("B", "executeCode", {
            code:
                `console.log("from B"); await storage.gateB; ` +
                `return { natural: penpot.flags.naturalChildOrdering, throwing: penpot.flags.throwValidationErrors };`,
        })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    storage.releaseA();
    await runA;
    storage.releaseB();
    await runB;

    return { a: responseData("A"), b: responseData("B") };
}

test("overlapping executions each return only their own console output", async () => {
    sentMessages.length = 0;
    const { a, b } = await runOverlapping();

    assert.equal(a.log, "[LOG] from A\n");
    assert.equal(b.log, "[LOG] from B\n");
});

test("an execution keeps the execution flags when an overlapping one finishes first", async () => {
    sentMessages.length = 0;
    const { b } = await runOverlapping();

    assert.deepEqual(b.result, { natural: true, throwing: true });
});

test("flags are restored once overlapping executions have finished", async () => {
    sentMessages.length = 0;
    await runOverlapping();

    assert.equal(penpotMock.flags.naturalChildOrdering, false);
    assert.equal(penpotMock.flags.throwValidationErrors, false);
});

test("flags are restored after a failing execution", async () => {
    resetFlags();
    const handler = new ExecuteCodeTaskHandler();

    await assert.rejects(handler.handle(new Task("fail", "executeCode", { code: `throw new Error("boom");` })));

    assert.equal(penpotMock.flags.naturalChildOrdering, false);
    assert.equal(penpotMock.flags.throwValidationErrors, false);
});
