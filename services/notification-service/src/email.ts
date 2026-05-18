import { Resend } from 'resend';
import type { TradeSignalDTO } from '@trader/shared-types';

export interface EmailSenderOptions {
    apiKey: string;
    toEmail: string;
}

export class EmailSender {
    private readonly resend: Resend;
    private readonly to: string;

    constructor(opts: EmailSenderOptions) {
        this.resend = new Resend(opts.apiKey);
        this.to     = opts.toEmail;
    }

    async send(signal: TradeSignalDTO): Promise<void> {
        const emoji = signal.action === 'BUY' ? '📈' : '📉';
        const rationale = (() => {
            try { return JSON.parse(signal.rationale) as { plain_english?: string; economic_mechanism?: string; uncertainty?: string }; }
            catch { return { plain_english: signal.rationale }; }
        })();

        const { error } = await this.resend.emails.send({
            from: 'trader@resend.dev',
            to: this.to,
            subject: `${emoji} ${signal.action} ${signal.ticker} — Confidence ${(signal.confidence * 100).toFixed(0)}%`,
            html: `
                <h2>${emoji} Trade Signal: ${signal.action} ${signal.ticker}</h2>
                <table border="1" cellpadding="6" style="border-collapse:collapse">
                    <tr><td><b>Confidence</b></td><td>${(signal.confidence * 100).toFixed(1)}%</td></tr>
                    <tr><td><b>Target Weight</b></td><td>${(signal.targetWeight * 100).toFixed(2)}%</td></tr>
                    <tr><td><b>Rationale</b></td><td>${rationale.plain_english ?? signal.rationale}</td></tr>
                    <tr><td><b>Economic Mechanism</b></td><td>${rationale.economic_mechanism ?? ''}</td></tr>
                    <tr><td><b>Uncertainty</b></td><td>${rationale.uncertainty ?? ''}</td></tr>
                    <tr><td><b>Time</b></td><td>${new Date(signal.timestamp).toISOString()}</td></tr>
                </table>
                <p><a href="http://trader.local/signals/${signal.id}">View full analysis →</a></p>
            `,
        });

        if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
    }
}
