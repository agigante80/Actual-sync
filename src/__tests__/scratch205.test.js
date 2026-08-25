// SCRATCH — verification harness for #205. Deleted before the ticket closes.
// Deliberately failing first, to prove a red PR cannot present as green after a
// retarget. Flipped to passing later in the same PR to prove the green path.
describe('#205 retarget re-test verification', () => {
    it('is deliberately failing so the PR is red', () => {
        expect('red').toBe('green');
    });
});
