import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// One-off reconciliation helper: look up specific QB PurchaseOrders by
// DocNumber, including line items. Pass ?docs=44266,44268,... The token
// never leaves the function.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const docsParam = url.searchParams.get('docs') || '';
  const docNumbers = docsParam.split(',').map((s) => s.trim()).filter(Boolean);

  if (docNumbers.length === 0) {
    return new Response(JSON.stringify({ success: false, error: 'Pass ?docs=comma,separated,doc,numbers' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: tokenRow, error: tokenErr } = await supabase
    .from('qb_tokens')
    .select('access_token, realm_id')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (tokenErr || !tokenRow) {
    return new Response(JSON.stringify({ success: false, error: 'No QB token found' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { access_token, realm_id } = tokenRow;
  const inList = docNumbers.map((d) => `'${d.replace(/'/g, "")}'`).join(',');
  const query = `SELECT * FROM PurchaseOrder WHERE DocNumber IN (${inList})`;
  const encodedQuery = encodeURIComponent(query);

  const qbRes = await fetch(
    `https://quickbooks.api.intuit.com/v3/company/${realm_id}/query?query=${encodedQuery}&minorversion=73`,
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json',
      },
    }
  );

  const bodyText = await qbRes.text();
  if (!qbRes.ok) {
    return new Response(JSON.stringify({ success: false, error: `QB API ${qbRes.status}: ${bodyText}` }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const qbData = JSON.parse(bodyText);
  const pos = qbData?.QueryResponse?.PurchaseOrder || [];
  const found = pos.map((po: any) => {
    const lines = (po.Line || []).filter((l: any) => l.DetailType === 'ItemBasedExpenseLineDetail');
    return {
      doc_number: po.DocNumber,
      id: po.Id,
      txn_date: po.TxnDate,
      vendor_name: po.VendorRef?.name,
      total: po.TotalAmt,
      status: po.POStatus,
      memo: po.Memo || po.PrivateNote || null,
      lines: lines.map((l: any) => ({
        item_name: l.ItemBasedExpenseLineDetail?.ItemRef?.name,
        item_id: l.ItemBasedExpenseLineDetail?.ItemRef?.value,
        qty: l.ItemBasedExpenseLineDetail?.Qty,
        unit_price: l.ItemBasedExpenseLineDetail?.UnitPrice,
        amount: l.Amount,
        description: l.Description || null,
      })),
    };
  });
  const foundDocNumbers = new Set(found.map((p: any) => p.doc_number));
  const missing = docNumbers.filter((d) => !foundDocNumbers.has(d));

  return new Response(JSON.stringify({ success: true, found, missing }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
