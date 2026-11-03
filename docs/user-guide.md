# Saybeam user guide

Saybeam shows live captions of what a speaker says. Everyone in the room can read them on their own phone, at their own text size. It is free, and nobody needs an account.

This guide is for three groups of people:

- [Speakers](#for-speakers): teachers, presenters and organisers who start a room.
- [Listeners](#for-listeners): anyone following the captions, including deaf and hard of hearing people.
- [Correctors](#for-correctors): helpers who fix mistakes in the captions while the speaker talks.

If something goes wrong, see [Troubleshooting](#troubleshooting).

Button names in this guide are shown in **bold**, exactly as they appear in Saybeam. The layout of the screens may change between versions, but the names stay the same.

## What you need

- **To speak:** a laptop or phone with a microphone, and a recent Chrome, Edge or Safari. Chrome and Edge give you the most choice of speech engines.
- **To listen:** any phone, tablet or computer with a web browser. Nothing to install.
- **The Saybeam address**, such as the one your school or organiser set up. If you run Saybeam yourself, see [deploy.md](deploy.md) or, for a classroom with weak internet, [LAN mode](#weak-or-no-internet-use-lan-mode).

## For speakers

### Start a room

1. Open Saybeam. Find **Start captioning**.
2. Type a **Session name** if you like, for example "Physics, Class 11B". Listeners see it.
3. Choose the **Spoken language**.
4. Turn on **Private room** if only invited people should follow. See [Private rooms](#private-rooms).
5. Select **Create a room**.

The speaker console opens. It shows the room code, a QR code, the live transcript, and panels for everything else.

The room belongs to this browser. It is listed under **Your rooms on this device** on the start page, so you can come back to it. **Forget** removes it from the list. If you clear this browser's data, you lose the speaker key, and you will need to start a new room.

### Choose a speech engine

Open the **Speech engine** panel. Saybeam looks at your device and shows a line starting **Suggested for this device**. The suggestion is a good place to start.

| Choice                 | How it works                                                                                                                                                      | Good for                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **On this device**     | A speech model runs inside your browser. Audio never leaves your device. The first time, the model downloads (about 55 to 300 MB, depending on the model).        | Privacy, ordinary laptops, classes offline |
| **Browser speech**     | Your browser's built-in recognition. Very light on the device. It needs internet, and audio goes to the browser maker (Google, Microsoft or Apple).               | Older or slower devices, a quick start     |
| **WhisperLive server** | A speech server that you or your organisation runs on a powerful computer. Ask whoever runs it for the **Server address**, **Model**, and **API key (optional)**. | Big events where accuracy matters most     |

With **On this device**:

- Choose a **Model**. Moonshine models are fast and understand English only. Whisper models understand many languages, including Hindi and mixed Hindi and English, but they are slower.
- **Runs on** can stay on **Automatic**.
- **Live partial captions** shows words while you are still speaking. Turn it off on a slow device.
- To prepare at home, select **Download model for offline use** while you have good Wi-Fi. Use the same browser and the same Saybeam address that you will use in class. In class, the model is already on your device.

With **Browser speech**:

- Set the **Language**: `en-IN` for Indian English, `hi-IN` for Hindi.
- In Chrome on a computer, you may see **Recognise on this device**. Turn it on to keep audio on your computer. If it needs a download, select **Download language pack** first.

If your computer has more than one microphone, choose one under **Microphone**.

More detail, including tips for Indian English and mixed Hindi and English speech, is in [Choosing a speech engine](engines.md).

### Start, pause and end

- Select **Start captioning** and speak. The first time, the browser asks to use the microphone: allow it.
- Your words appear in the transcript, and on every listener's phone. The screen stays on while you caption, where the browser allows it.
- Select **Pause** to stop listening for a while. Listeners see that captions are paused. Select **Resume captioning** to carry on.
- If the connection drops, keep talking. A banner tells you that captions are saved on your device. They are sent when the connection returns, and show a **sending** label until then.
- When you finish, open **Session** and select **End session for everyone**. Listeners keep what they have already received.

To change the engine, pause first.

### Put the code and QR code on screen

The **Invite the audience** panel shows the QR code, the room code and the address.

- **Show QR on screen** fills the screen with the QR code and the code, for a projector. Select **Close**, press Escape, or click anywhere to go back.
- **Copy link** copies the listener link, to paste into a chat or an email. On phones, **Share** opens the phone's share menu.
- Listeners can scan the QR code, or type the code on the start page. Codes never use the letters I, L or O, or the digits 0 and 1, so they are easy to read aloud.

### Private rooms

By default, the room code is the key. Anyone who has the code can follow. That suits lectures, worship and conferences.

A **private room** needs more than the code. Listeners must scan the QR code or open the full link, because it carries a secret. Someone who only knows the code cannot join, and does not see the session name.

- Turn on **Private room** when you create the room. You cannot make an existing room private: start a new one instead.
- On the projector, a private room shows only the QR code, not the code.
- Treat the QR code and the link like a key. Anyone who has them can share them further.

Saybeam is not designed for confidential meetings. Read [SECURITY.md](../SECURITY.md#how-saybeam-protects-rooms) if you are unsure.

### Replace a link

If a link reaches the wrong people, replace it. Open **Helpers and devices**:

- Under **Corrector link**, select **Replace link**. The old corrector link stops working at once, and your helper is disconnected. Send them the new link.
- In a private room, select **Replace audience link**. Everyone following is disconnected, and must scan the new QR code.

You need to be online to replace a link. If you use a hand-off link (see below), copy a fresh one afterwards.

In a public room the code itself cannot be replaced. To keep someone out, end the session and start a new room.

### Fix mistakes, names and jargon

- **Click any line** in the transcript to fix it. Press Enter to save, or Escape to cancel. **Remove line** removes it for everyone. Fixed lines are marked **edited**.
- Open **Words and names**:
  - **Word replacements** fix words the engine keeps getting wrong, one rule per line, for example `foto synthesis => photosynthesis`. They are applied before captions leave your device.
  - **Vocabulary** is a list of names and subject words. It helps Chrome's on-device recognition and WhisperLive. It takes effect the next time you start captioning.

### Bring in a corrector

A corrector is a helper who fixes captions live, so you can keep talking.

1. Open **Helpers and devices** and select **Copy corrector link**.
2. Send the link privately to your helper. Anyone with it can change the captions.

The top of the console shows how many people are following, and how many are correcting.

### Caption from another device

To caption from a different device, for example a phone closer to the speaker, open **Helpers and devices** and select **Copy hand-off link**. Open that link on the other device. Treat it like a password.

Only one device captions at a time. As soon as the console opens on the new device, the old one stops and says so.

### Download the transcript

Open **Session**. Under **Download transcript**, choose a format:

- **TXT**: plain text, for notes and sharing.
- **SRT** or **VTT** (WebVTT): subtitles with timings, for a recording of the session.
- **JSON**: for other programs.

**Let listeners download the transcript** is on by default. Turn it off if listeners should not save it.

On a cloud server, rooms and transcripts are deleted 24 hours after the last caption, so download what you need before then. On a LAN relay, they last until the relay stops.

## For listeners

### Join a room

- **Scan the QR code** with your phone's camera. The captions open in your browser.
- Or open Saybeam and type the code under **Follow captions**, then select **Show captions**. Capital letters and spaces do not matter.
- For a **private room**, scan the QR code or open the full link from the organiser. You can also paste the full link into the code box.

There is no app to install and no account. Nobody learns who you are.

The status at the top tells you what is happening: **Live**, **Paused**, **Waiting for speaker**, **Reconnecting** or **Ended**.

### Make the captions easy to read

Select the **Aa** button. Screen readers call it **Display settings**.

- **Text size**: use the slider, or **Smaller** and **Larger**.
- **Colours**: **White on black**, **Yellow on black**, **Black on white**, **Black on yellow** or **Low glare**.
- **Font**: a choice of fonts, including Atkinson Hyperlegible, which was designed for people with low vision. You can also change **Line spacing** and **Letter spacing**.
- **Layout**: **Full transcript** to scroll through everything, or **Latest lines only** for a few large lines. Choose **Left** or **Centre** alignment.
- **Options**:
  - **Bold text** and **ALL CAPS**.
  - **Show words as they are recognised**: words appear sooner, but may change for a moment before they settle.
  - **Show times** next to each paragraph.
  - **Keep screen on**, so your phone does not lock during a long talk.
  - **Announce new captions to screen readers**, for screen reader and braille display users.

**Reset to defaults** puts everything back. **Done** closes the settings. Your settings stay on your own device and apply to every room.

### Scroll back, then return to live

Scroll up at any time to reread something. The captions stop moving while you read.

When you are ready, select **Back to live**. It shows how many new lines arrived while you were away. With a keyboard, press End.

To see older lines, scroll to the top and select **Show earlier captions**.

If the speaker or a corrector fixes a line, it changes on your screen too.

### If the connection drops

Saybeam reconnects by itself. When it is back, it catches up on everything you missed, including fixes.

### Save the transcript

If the speaker allows it, open **Display settings** and select **Save as text**, **Save as SRT** or **Save as WebVTT**. When the session ends, **Save as text** and **Save as SRT** also appear next to the message that the session has ended.

### Install Saybeam on your phone (optional)

You do not need to install anything. If you use Saybeam often, you can add it to your home screen:

- **Android, Chrome:** open the browser menu and choose the option to install the app or add it to the home screen.
- **iPhone and iPad, Safari:** select the Share button, then **Add to Home Screen**.

The installed app opens the Saybeam start page. Scan or type the code as usual. On a LAN relay (an address starting with `http://`), your browser may not offer to install it; just use the page.

## For correctors

1. Open the corrector link the speaker sent you. It ends with a long secret after a `#` sign. Keep it to yourself.
2. You see the live transcript. Click a line, or Tab to it and press Enter.
3. Type the fix. Press Enter or select **Save**. Press Escape or select **Cancel** to leave it as it was.
4. To delete a line, select **Remove line**, or clear the text and save. This is useful for lines the engine made up during silence.

Fixes reach every phone instantly, and fixed lines are marked **edited**. The newest line, which is still forming, cannot be edited: wait a moment for it to settle.

Tips:

- Saybeam keeps the corrector link only in this browser tab. If you close the tab, open the link from the speaker's message again.
- If you see "This link is not valid any more", the speaker has replaced it. Ask for the new one.

## Troubleshooting

### The microphone does not work

- **You blocked the microphone by mistake.** Open the site settings (usually the icon to the left of the address), allow the microphone, and reload the page.
- **"This browser cannot use the microphone here."** Browsers only allow the microphone on secure (`https://`) addresses, or on `localhost`. On a LAN relay, the speaker must open `http://localhost:7300` on the laptop that runs the relay.
- **"No microphone found."** Plug in a microphone, then choose it under **Microphone** in the **Speech engine** panel.
- **"Microphone or speech service blocked."** Allow the microphone for the site, and check that you are online if you use **Browser speech**.
- **Still nothing?** Check that the computer itself lets the browser use the microphone (on Windows: Settings, Privacy and security, Microphone; on a Mac: System Settings, Privacy and Security, Microphone). Close other apps that may be using the microphone, such as a video call.

### iPhone and iPad

- iOS does not allow speech recognition in web apps added to the home screen. To speak from an iPhone or iPad, open Saybeam in Safari itself, or choose **On this device**. The suggestion already does this.
- Listening works normally on iPhone and iPad, in Safari or from the home screen.

### Captions are slow or fall behind

- Open **Performance**. If it says "This device is falling behind", try **Moonshine Tiny**, turn off **Live partial captions**, or switch to **Browser speech**.
- Close other tabs and programs, and keep a laptop plugged in.

### Captions have wrong words

- Use a microphone close to the speaker, and reduce background noise.
- Add **Word replacements** and **Vocabulary** in **Words and names**.
- Check the **Spoken language** and engine language, such as `en-IN` for Indian English.
- Ask a helper to be the [corrector](#for-correctors).

We have not yet measured accuracy for Indian-accented or mixed Hindi and English speech, or speed on low-cost devices. If you can help, [risk-tests.md](risk-tests.md) explains how.

### Weak or no internet: use LAN mode

In a school with poor internet, run the **Saybeam relay** on the teacher's laptop. The laptop becomes the caption server. Phones join over the school Wi-Fi, or over the laptop's own hotspot, with no internet at all.

1. Download the relay for Windows, macOS or Linux from the project's [releases page](https://github.com/byjoellobo/saybeam/releases), unpack it and start it. Allow it through the firewall when asked.
2. On the laptop, open `http://localhost:7300` and start a room as usual.
3. Students join the same Wi-Fi or hotspot, then scan the QR code.

For on-device speech with no internet at all, the relay can also serve the speech models. Whoever sets up the relay downloads them once, while there is internet. If phones cannot reach the laptop on the school Wi-Fi, use the laptop's hotspot instead. The full classroom guide, including offline models, is in [relay/README.md](../relay/README.md).

On a cloud server with patchy Wi-Fi, you can usually carry on: the speaker's captions are kept and sent when the connection returns, and listeners catch up when they reconnect.

### Messages you might see

| Message                                                                    | What it means and what to do                                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| "No room with that code. Check it with the speaker."                       | The code is wrong, or the room no longer exists. Check the code.                                                              |
| "This is a private room. Scan the QR code or open the full link..."        | The code alone is not enough. Scan the QR code, or ask the organiser for the link.                                            |
| "This link is not valid any more. Ask the organiser for a fresh one."      | The speaker replaced the link. Ask for the new one.                                                                           |
| "This room has expired."                                                   | Cloud rooms are deleted 24 hours after the last activity, and after 72 hours at most. Start a new room.                       |
| "Captioning moved to another tab or device. This one has stopped sending." | The room is captioning from somewhere else, such as a hand-off link. Use that device, or reopen this one.                     |
| "This browser is not the speaker for ..."                                  | The speaker key lives in the browser that created the room. Use the hand-off link, or select **Follow the captions instead**. |
| **Waiting for speaker**                                                    | You are in the room, but the speaker's console is not open right now. Captions start when it is.                              |

### Privacy in brief

- With **On this device**, audio never leaves the speaker's device. Only caption text is sent.
- With **Browser speech**, audio goes to the browser maker's speech service, unless on-device recognition is on. With **WhisperLive**, audio goes to that server.
- Whoever runs the Saybeam server can read the captions of rooms on it. Cloud rooms are deleted 24 hours after the last caption.

The **About** page in Saybeam and [SECURITY.md](../SECURITY.md) have the details.
