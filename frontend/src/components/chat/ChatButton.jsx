/**
 * ChatButton — fixed floating toggle for the AI assistant.
 * Shows a pulse dot when a new bot message has arrived and the panel is closed.
 */
export default function ChatButton({ isOpen, onClick, hasUnread }) {
  return (
    <button
      onClick={onClick}
      aria-label={isOpen ? 'Close AI assistant' : 'Open AI assistant'}
      className="fixed bottom-4 right-4 z-50 w-14 h-14 bg-slate-900 hover:bg-slate-700
                 text-white rounded-full shadow-2xl flex items-center justify-center
                 transition-all duration-200 hover:scale-105 active:scale-95"
    >
      {isOpen ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      ) : (
        <span className="text-2xl select-none">🤖</span>
      )}

      {/* Unread notification dot */}
      {hasUnread && !isOpen && (
        <span className="absolute top-0.5 right-0.5 w-3.5 h-3.5 bg-red-500 rounded-full
                         border-2 border-white animate-pulse" />
      )}
    </button>
  );
}
