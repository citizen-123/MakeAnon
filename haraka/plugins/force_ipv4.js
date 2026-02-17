// Force IPv4 for outbound connections
exports.hook_get_mx = function (next, hmail, domain) {
    // Set bind address to our IPv4 address (replaced at runtime by entrypoint)
    hmail.todo.notes.outbound_ip = "${PUBLIC_IP}";
    next();
};
