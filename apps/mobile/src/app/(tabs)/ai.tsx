import { createProviderTransport, parseTripRequest, type ChatMessage } from '@trailpack/ai';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { Button, Card, KeyValueTable, Screen, SectionHeader, Text, TextField, toast } from '@/components/ui';
import { errorMessage, useT } from '@/i18n';
import { useAiKeyStore } from '@/stores/ai';
import { useSettingsStore } from '@/stores/settings';
import { useTheme } from '@/theme/ThemeProvider';

const SYSTEM = 'Jsi asistent pro plánování outdoorových výprav (pěší turistika, bikepacking). Odpovídej česky, stručně a věcně. Nevymýšlej si fakta, pokud něco nevíš, řekni to.';

export default function AiScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useT();
  const settings = useSettingsStore((s) => s.settings);
  const apiKey = useAiKeyStore((s) => s.apiKey);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ReturnType<typeof parseTripRequest> | null>(null);
  const [chat, setChat] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const configured = settings.aiProvider === 'openai_compatible' ? !!settings.aiBaseUrl : !!apiKey.trim();
  const model = settings.aiModel || (settings.aiProvider === 'anthropic' ? 'claude-opus-5-5' : '');

  const rows = parsed
    ? Object.entries(parsed.fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => ({ label: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }))
    : [];

  const createTrip = () => {
    if (!parsed) return;
    const f = parsed.fields;
    router.push({
      pathname: '/trips',
      params: {
        new: '1',
        ...(f.days ? { days: String(f.days) } : {}),
        ...(f.maxDailyKm ? { maxKm: String(f.maxDailyKm) } : {}),
        ...(f.activity ? { activity: f.activity } : {}),
        ...(f.regionQuery || f.region ? { region: f.regionQuery ?? f.region } : {}),
        ...(f.startDate ? { startDate: f.startDate } : {}),
        ...(f.region ? { name: `Výprava – ${f.region}` } : {}),
      },
    });
  };

  const send = async () => {
    const q = msg.trim();
    if (!q) return;
    setBusy(true);
    const history = [...chat, { role: 'user' as const, text: q }];
    setChat(history);
    setMsg('');
    try {
      const transport = createProviderTransport(settings.aiProvider, { apiKey, baseUrl: settings.aiBaseUrl }, { browserDirect: Platform.OS === 'web' });
      const messages: ChatMessage[] = history.map((m) => ({ role: m.role, parts: [{ type: 'text', text: m.text }] }));
      const res = await transport.chat({ provider: settings.aiProvider, model, system: SYSTEM, messages, maxTokens: 1024, baseUrl: settings.aiBaseUrl });
      const answer = res.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trim();
      setChat([...history, { role: 'assistant', text: answer || '(prázdná odpověď)' }]);
    } catch (e) {
      toast.error(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Asistent" subtitle="Plánování výpravy z textu">
      <Card>
        <SectionHeader title="Analýza zadání (offline)" />
        <TextField label="Popište výpravu" value={text} onChangeText={setText} lines={4} placeholder="Např. 4 dny v Beskydech, pěšky, max 20 km denně, od 12. 7." />
        <View style={{ height: theme.spacing.sm }} />
        <Button label="Analyzovat (offline)" onPress={() => setParsed(parseTripRequest(text, new Date()))} disabled={!text.trim()} />
        {parsed ? (
          <View style={{ marginTop: theme.spacing.md, gap: theme.spacing.sm }}>
            <Text variant="caption" tone="muted">
              Jistota rozpoznání: {Math.round(parsed.confidence * 100)} %
            </Text>
            {rows.length > 0 ? <KeyValueTable rows={rows} /> : <Text tone="muted">Nic se nepodařilo rozpoznat.</Text>}
            {parsed.missing.length > 0 ? (
              <View>
                <Text variant="label">Chybí upřesnit</Text>
                {parsed.missing.map((m) => (
                  <Text key={m}>• {m}</Text>
                ))}
              </View>
            ) : null}
            <Button label="Vytvořit výpravu" icon="plus" onPress={createTrip} />
          </View>
        ) : null}
      </Card>
      <View style={{ height: theme.spacing.md }} />
      <Card>
        <SectionHeader title="Chat s AI (vlastní API klíč)" />
        {!configured ? (
          <Text tone="muted">Chat je vypnutý. Zadejte poskytovatele a API klíč v Nastavení (ikona ozubeného kola na úvodní obrazovce). Bez klíče se nic neodesílá.</Text>
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="caption" tone="muted">
              Poskytovatel: {settings.aiProvider} · model: {model || 'nezadán'}. Dotazy se odesílají přímo poskytovateli s vaším klíčem.
            </Text>
            {chat.map((m, i) => (
              <Text key={i} tone={m.role === 'user' ? 'primary' : 'default'}>
                {m.role === 'user' ? 'Vy: ' : 'AI: '}
                {m.text}
              </Text>
            ))}
            <TextField label="Zpráva" value={msg} onChangeText={setMsg} lines={2} />
            <Button label="Odeslat" onPress={() => void send()} loading={busy} disabled={!msg.trim()} />
          </View>
        )}
      </Card>
    </Screen>
  );
}
