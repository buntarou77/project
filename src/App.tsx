import { Navigate, Route, Routes } from 'react-router-dom'
import StudioApp from './studio/StudioApp'
import OwnerApp from './owner/OwnerApp'

function PlatformIndex() {
  return (
    <div className="center-page">
      <div className="card">
        <div className="overline">Платформа записи</div>
        <h2>Демо-студии</h2>
        <p className="muted">Откройте ссылку студии вида /s/&lt;slug&gt;. Кабинет владельца: /owner.</p>
        <div className="chips">
          <a className="chip" href="/s/kadr-studio">Фотостудия «Кадр»</a>
          <a className="chip" href="/s/anna-vetrova">Анна Ветрова, фотограф</a>
          <a className="chip" href="/owner">Кабинет владельца</a>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PlatformIndex />} />
      <Route path="/s/:slug/*" element={<StudioApp />} />
      <Route path="/owner/*" element={<OwnerApp />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
