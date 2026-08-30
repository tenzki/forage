import { ArrowLeft } from 'lucide-react'

interface SecondaryViewHeaderProps {
  title: string
  onBack: () => void
}

export function SecondaryViewHeader({ title, onBack }: SecondaryViewHeaderProps) {
  return (
    <header className="secondary-view-header">
      <button className="secondary-view-back" aria-label="Back to outline" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        <span>Back</span>
      </button>
      <h1>{title}</h1>
    </header>
  )
}
