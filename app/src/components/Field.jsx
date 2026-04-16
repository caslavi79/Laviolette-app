/* Lightweight form-field wrapper. Shared across every edit form.
 * Renders label above input/select/textarea; error text below if set.
 */
export function Field({ id, label, error, children, hint, span }) {
  const cls = `field${error ? ' field--error' : ''}${span ? ` field--span-${span}` : ''}`
  return (
    <div className={cls}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <div className="field-hint">{hint}</div>}
      {error && <div className="field-error">{error}</div>}
    </div>
  )
}

/* Convenience helpers that wire value/onChange into the parent form state. */
export function TextField({ id, label, value, onChange, error, hint, type = 'text', required, span, ...rest }) {
  return (
    <Field id={id} label={label} error={error} hint={hint} span={span}>
      <input
        id={id}
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        {...rest}
      />
    </Field>
  )
}

export function TextareaField({ id, label, value, onChange, error, hint, rows = 3, span = 'full', ...rest }) {
  return (
    <Field id={id} label={label} error={error} hint={hint} span={span}>
      <textarea
        id={id}
        rows={rows}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    </Field>
  )
}

export function SelectField({ id, label, value, onChange, options, error, hint, span, placeholder }) {
  return (
    <Field id={id} label={label} error={error} hint={hint} span={span}>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((opt) => {
          const value = typeof opt === 'string' ? opt : opt.value
          const label = typeof opt === 'string' ? opt : (opt.label ?? opt.value)
          return <option key={value} value={value}>{label}</option>
        })}
      </select>
    </Field>
  )
}
