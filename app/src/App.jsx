import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Today from './pages/Today'
import Schedule from './pages/Schedule'
import Contacts from './pages/Contacts'
import Projects from './pages/Projects'
import Money from './pages/Money'
import Contracts from './pages/Contracts'
import Sign from './pages/Sign'
import SetupSuccess from './pages/SetupSuccess'
import SetupCancel from './pages/SetupCancel'
import './App.css'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/sign" element={<Sign />} />
        <Route path="/setup-success" element={<SetupSuccess />} />
        <Route path="/setup-cancel" element={<SetupCancel />} />

        {/* Authenticated routes */}
        <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<Today />} />
          <Route path="schedule" element={<Schedule />} />
          <Route path="contacts" element={<Contacts />} />
          <Route path="projects" element={<Projects />} />
          <Route path="money" element={<Money />} />
          <Route path="contracts" element={<Contracts />} />
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
