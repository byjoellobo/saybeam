# Saybeam documentation

Find the page for what you want to do. The project overview is in the [main README](../README.md).

## Using Saybeam

For teachers, speakers, organisers, listeners and correctors.

- [User guide](user-guide.md): start a room, choose a speech engine, share the QR code, follow captions on your phone, correct captions, download the transcript, and fix common problems.
- [Choosing a speech engine](engines.md): on-device models, browser speech and WhisperLive compared, with tips for Indian English and mixed Hindi and English speech.

## Running Saybeam

For schools, IT staff and anyone hosting their own copy.

- [Deploying](deploy.md): the Cloudflare cloud version, a WhisperLive server for big events, and LAN mode in short.
- [Self-hosting](self-hosting.md): the relay on your own server, with Docker, HTTPS and docker compose.
- [LAN relay](../relay/README.md): captions over school Wi-Fi with no internet, downloads, every flag, and offline speech models.
- [Security policy](../SECURITY.md): how rooms are protected, what is not protected, and how to report a vulnerability.

## Contributing

For developers and field testers.

- [Contributing guide](../CONTRIBUTING.md): set up the project, run the tests, house style and DCO sign-off.
- [Architecture](architecture.md): how the pieces fit together, and where to start reading the code.
- [Wire protocol](protocol.md): the HTTP and WebSocket protocol that both servers implement.
- [Risk tests](risk-tests.md): the field-test plan for speed on low-end devices and accuracy for Indian-accented and code-mixed speech. You can help without writing code.
- [Code of conduct](../CODE_OF_CONDUCT.md).

## Maintaining

For maintainers.

- [Releasing](releasing.md): version policy, the release steps, and fixing a bad release.
- [CI and CD](ci-cd.md): every workflow, the secrets and settings they need, and how to run the same checks locally.
- [Changelog](../CHANGELOG.md): what changed in each version.
- Third-party licenses: [web app and Worker](../THIRD_PARTY_NOTICES.md), [relay](../relay/THIRD_PARTY_LICENSES.md).
