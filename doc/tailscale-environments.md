# Run agent tasks on a Tailscale machine

A Tailscale environment runs tasks on an existing machine that you own. Paperclip
connects to its SSH server through your tailnet. It uses the same task execution,
workspace synchronization, logs, and cancellation paths as an SSH environment.

In **Environments**, add an environment and select **Tailscale**. Enter the
machine's MagicDNS name or Tailscale IP address, SSH port, SSH username, and an
absolute workspace path. Configure the SSH private key and trusted host keys as
you would for an SSH environment. The machine needs a working SSH server and the
runtime prerequisites for your selected agent runner.

Create a device auth key in the destination tailnet and enter it in **Tailscale
connection key**. Save the environment, then select **Test connection** from the
environment list. Assign this environment to the agent or execution workspace
that should run tasks on the machine. The tailnet policy must allow the Paperclip
connection to reach the machine's SSH port. Tailscale network authorization and
SSH authentication are separate: use the credentials accepted by that machine's
SSH server, including its Tailscale SSH policy when enabled.

Paperclip joins a small network client to the tailnet. It does not create or
replace the target machine. The client uses userspace networking, accepts no
subnet routes or DNS changes, and blocks incoming connections. Each connection
has a private socket and state directory. Connections from different companies
use separate identities. A saved connection secret can be shared deliberately
by multiple environments in its company.

The initial key is stored through the configured company secret provider. After
the first connection, Paperclip replaces its current secret value with the
Tailscale node state before allowing task execution. This preserves the identity
across restarts and allows single-use auth keys. The key and node state never
appear in environment API responses, task arguments, or logs. The local key file
is removed after login. Node state is restored into a private temporary directory
and removed when the network client stops. The host requires `tailscale` and
`tailscaled` on its PATH; the Cloud image supplies both. No daemon starts for
direct SSH environments or during server startup.

Enter a new auth key to reconnect when a node is revoked, its key expires, or
the machine moves to another tailnet. Deleting an environment removes its secret
binding. Company secrets and registered tailnet nodes have their own lifecycle;
remove unused credentials and nodes through their respective settings. Paperclip
does not delete a machine that you own.

This setup uses [device auth keys](https://tailscale.com/docs/features/auth-keys).
It does not need an Apps connector or an OAuth app. Tailscale currently limits
[OAuth app consent](https://tailscale.com/docs/features/oauth-apps) to users in
the app's own tailnet, so one shared Cloud app cannot authorize every customer's
tailnet. A device auth key supports an existing machine in either tailnet.

Local tests use child-process fixtures and make no provider calls. Before a
release, qualify a real tailnet: save a single-use key, run a task that writes
a file on the target, read the result through Paperclip, restart the Cloud
instance, and repeat without entering another key. Also test a denied tailnet
policy and a revoked node. Fixture tests do not establish this live proof.
