import { useRoute } from './lib/router';
import { Home } from './pages/Home';
import { Listener } from './pages/Listener';
import { Speaker } from './pages/Speaker';
import { Corrector } from './pages/Corrector';
import { Bench } from './pages/Bench';
import { About } from './pages/About';
import { navigate } from './lib/router';
import { SiteHeader } from './components/SiteHeader';

export function App() {
  const route = useRoute();
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'listen':
      return <Listener key={route.code} code={route.code} />;
    case 'speak':
      return <Speaker key={route.code} code={route.code} />;
    case 'fix':
      return <Corrector key={route.code} code={route.code} />;
    case 'bench':
      return <Bench />;
    case 'about':
      return <About />;
    case 'not-found':
      return (
        <div class="page">
          <SiteHeader />
          <main class="narrow" id="main">
            <h1>That page does not exist</h1>
            <p>Room links look like /r/ABC234. Check the code with the speaker.</p>
            <button type="button" class="btn btn-primary" onClick={() => navigate('/')}>
              Go to the start page
            </button>
          </main>
        </div>
      );
  }
}
