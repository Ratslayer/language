function pronunciationControl(button, status, install, callHost) {
  const synth = window.speechSynthesis;
  let selected, playback;

  function clear() {
    selected = null;
    if (playback) {
      playback = null;
      if (callHost) callHost('speech.stop').catch(() => {});
      else synth.cancel();
    }
    button.hidden = true;
    status.textContent = '';
    install.hidden = true;
  }

  button.onclick = async () => {
    if (!selected) return;
    const {text, language, name} = selected;
    const attempt = {};
    playback = attempt;
    status.textContent = '';
    install.hidden = true;
    try {
      if (callHost) {
        // Imported books can contain passages longer than Android's 4,000 UTF-16 unit limit.
        let remaining = text;
        while (remaining && playback === attempt) {
          let end = remaining.length;
          if (end > 4000) {
            end = remaining.lastIndexOf(' ', 4000);
            if (end < 1) end = /[\uD800-\uDBFF]/.test(remaining[3999]) ? 3999 : 4000;
          }
          const result = await callHost('speech.speak', {text:remaining.slice(0,end), language});
          if (result === 'missing-voice' && playback === attempt) {
            status.textContent = 'An offline ' + name + ' voice is needed.';
            install.textContent = 'Install ' + name + ' voice';
            install.hidden = false;
          }
          if (result !== 'spoken') break;
          remaining = remaining.slice(end).trimStart();
        }
      } else {
        synth.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = language;
        utterance.onend = () => { if (playback === attempt) playback = null; };
        utterance.onerror = () => {
          if (playback !== attempt) return;
          playback = null;
          status.textContent = 'Could not play the ' + name + ' voice in this browser.';
        };
        synth.speak(utterance);
        return;
      }
    } catch (error) {
      if (playback === attempt) status.textContent = error.message === 'Unsupported tool action.'
        ? 'Update AI Pages to use pronunciation.' : error.message;
    }
    if (playback === attempt) playback = null;
  };

  install.onclick = async () => {
    const word = selected;
    try { await callHost('speech.installVoices'); }
    catch (error) { if (selected === word) status.textContent = error.message; }
  };

  return {
    select(text, language, name, fullSentence = false) {
      selected = {text, language, name};
      button.title = fullSentence ? 'Pronounce sentence' : 'Pronounce word';
      button.setAttribute('aria-label', fullSentence ? button.title : 'Pronounce ' + text);
      button.hidden = !(callHost || (synth && window.SpeechSynthesisUtterance));
    },
    clear
  };
}
