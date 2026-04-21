import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import ErrorBoundary from './components/ErrorBoundary'
import Login from './pages/Login'
import Today from './pages/Today'
import Schedule from './pages/Schedule'
import Contacts from './pages/Contacts'
import Projects from './pages/Projects'
import Money from './pages/Money'
import Contracts from './pages/Contracts'
import Notifications from './pages/Notifications'
import Sign from './pages/Sign'
import SetupSuccess from './pages/SetupSuccess'
import SetupCancel from './pages/SetupCancel'
import './App.css'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<ErrorBoundary><Login /></ErrorBoundary>} />
        <Route path="/sign" element={<ErrorBoundary><Sign /></ErrorBoundary>} />
        <Route path="/setup-success" element={<ErrorBoundary><SetupSuccess /></ErrorBoundary>} />
        <Route path="/setup-cancel" element={<ErrorBoundary><SetupCancel /></ErrorBoundary>} />

        {/* Authenticated routes */}
        <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<ErrorBoundary><Today /></ErrorBoundary>} />
          <Route path="schedule" element={<ErrorBoundary><Schedule /></ErrorBoundary>} />
          <Route path="contacts" element={<ErrorBoundary><Contacts /></ErrorBoundary>} />
          <Route path="projects" element={<ErrorBoundary><Projects /></ErrorBoundary>} />
          <Route path="money" element={<ErrorBoundary><Money /></ErrorBoundary>} />
          <Route path="contracts" element={<ErrorBoundary><Contracts /></ErrorBoundary>} />
          <Route path="notifications" element={<ErrorBoundary><Notifications /></ErrorBoundary>} />
          <Route
            path="*"
            element={
              <div className="placeholder">
                <h1>Page Not Found</h1>
                <p>This page doesn't exist.</p>
              </div>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
