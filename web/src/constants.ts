// Voice-design attribute options (build an `instruct` string) and a curated
// language list. OmniVoice supports 600+ languages; "Auto" lets it detect.

export const DESIGN_CATEGORIES: { label: string; key: string; options: string[] }[] = [
  { label: 'Gender', key: 'gender', options: ['male', 'female'] },
  { label: 'Age', key: 'age', options: ['child', 'teenager', 'young adult', 'middle-aged', 'elderly'] },
  {
    label: 'Pitch',
    key: 'pitch',
    options: ['very low pitch', 'low pitch', 'moderate pitch', 'high pitch', 'very high pitch'],
  },
  { label: 'Style', key: 'style', options: ['whisper'] },
  {
    label: 'Accent (English)',
    key: 'accent',
    options: [
      'american accent',
      'british accent',
      'australian accent',
      'canadian accent',
      'indian accent',
      'irish accent',
      'russian accent',
      'japanese accent',
      'korean accent',
    ],
  },
]

export const LANGUAGES = [
  'Auto',
  'English',
  'Chinese',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Russian',
  'Japanese',
  'Korean',
  'Arabic',
  'Hindi',
  'Dutch',
  'Polish',
  'Turkish',
  'Vietnamese',
  'Indonesian',
  'Thai',
]
