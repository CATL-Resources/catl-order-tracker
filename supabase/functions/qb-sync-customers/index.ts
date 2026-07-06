import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = () => createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function getAccessToken(): Promise<{ access_token: string; realm_id: string }> {
  const sb = supabase();
  const { data: tokenRow, error } = await sb.from('qb_tokens').select('*').limit(1).single();
  if (error || !tokenRow) throw new Error('No QuickBooks tokens found.');

  const now = new Date();
  const expiresAt = new Date(tokenRow.access_token_expires_at);

  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    const clientId = Deno.env.get('QB_CLIENT_ID')!;
    const clientSecret = Deno.env.get('QB_CLIENT_SECRET')!;
    const basicAuth = btoa(`${clientId}:${clientSecret}`);
    const refreshResp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenRow.refresh_token })
    });
    if (!refreshResp.ok) throw new Error(`Token refresh failed: ${await refreshResp.text()}`);
    const newTokens = await refreshResp.json();
    await sb.from('qb_tokens').update({
      access_token: newTokens.access_token, refresh_token: newTokens.refresh_token,
      access_token_expires_at: new Date(now.getTime() + newTokens.expires_in * 1000).toISOString(),
      refresh_token_expires_at: new Date(now.getTime() + newTokens.x_refresh_token_expires_in * 1000).toISOString(),
      updated_at: now.toISOString()
    }).eq('id', tokenRow.id);
    return { access_token: newTokens.access_token, realm_id: tokenRow.realm_id };
  }
  return { access_token: tokenRow.access_token, realm_id: tokenRow.realm_id };
}

Deno.serve(async (req: Request) => {
  try {
    // Parse optional page parameter — lets us call in chunks if needed
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const pageSize = 500;
    const startPosition = (page - 1) * pageSize + 1;

    const { access_token, realm_id } = await getAccessToken();
    const baseUrl = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;
    const sb = supabase();

    // Get count first
    const countResp = await fetch(
      `${baseUrl}/query?query=${encodeURIComponent('SELECT COUNT(*) FROM Customer')}&minorversion=73`,
      { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' } }
    );
    const countData = await countResp.json();
    const totalCount = countData.QueryResponse?.totalCount || 0;

    // Fetch this page of customers
    const query = `SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    const resp = await fetch(
      `${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=73`,
      { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' } }
    );

    if (!resp.ok) throw new Error(`QB query failed: ${await resp.text()}`);
    const data = await resp.json();
    const customers = data.QueryResponse?.Customer || [];

    // Map all customers to our format
    const rows = customers.map((qbCust: any) => {
      const addr = qbCust.BillAddr || qbCust.ShipAddr || {};
      return {
        name: qbCust.DisplayName || qbCust.CompanyName || `${qbCust.GivenName || ''} ${qbCust.FamilyName || ''}`.trim(),
        company: qbCust.CompanyName || null,
        email: qbCust.PrimaryEmailAddr?.Address || null,
        phone: qbCust.PrimaryPhone?.FreeFormNumber || qbCust.Mobile?.FreeFormNumber || null,
        address_line1: addr.Line1 || null,
        address_city: addr.City || null,
        address_state: addr.CountrySubDivisionCode || null,
        address_zip: addr.PostalCode || null,
        qb_customer_id: String(qbCust.Id),
        updated_at: new Date().toISOString()
      };
    });

    // Bulk upsert — use qb_customer_id as the conflict key
    if (rows.length > 0) {
      const { error: upsertError } = await sb.from('customers').upsert(rows, {
        onConflict: 'qb_customer_id',
        ignoreDuplicates: false
      });

      if (upsertError) {
        console.error('Upsert error:', upsertError);
        throw new Error(`Upsert failed: ${upsertError.message}`);
      }
    }

    const hasMore = startPosition + pageSize - 1 < totalCount;

    return new Response(JSON.stringify({
      success: true,
      total_in_qb: totalCount,
      synced_this_page: rows.length,
      page: page,
      has_more: hasMore,
      next_url: hasMore ? `https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/qb-sync-customers?page=${page + 1}` : null
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('qb-sync-customers error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
});
