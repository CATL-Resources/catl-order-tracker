import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run !== false; // default to dry run

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get QB token
    const { data: tokenRow } = await supabase
      .from('qb_tokens')
      .select('access_token, realm_id')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (!tokenRow) {
      return new Response(JSON.stringify({ success: false, error: 'No QB token' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { access_token, realm_id } = tokenRow;

    // Get all base models for matching
    const { data: baseModels } = await supabase
      .from('base_models')
      .select('id, name, qb_item_id, qb_item_name, cost_price, retail_price, manufacturer_id');

    const baseModelByQbId = new Map();
    for (const bm of baseModels || []) {
      if (bm.qb_item_id) baseModelByQbId.set(bm.qb_item_id, bm);
    }

    // Get all model options for matching
    const { data: modelOptions } = await supabase
      .from('model_options')
      .select('id, name, qb_item_id, qb_item_name, cost_price, retail_price, category, option_type');

    const optionByQbId = new Map();
    for (const opt of modelOptions || []) {
      if (opt.qb_item_id) optionByQbId.set(opt.qb_item_id, opt);
    }

    // Get manufacturer mapping by QB vendor ID
    const { data: manufacturers } = await supabase
      .from('manufacturers')
      .select('id, name, qb_vendor_id');

    const mfgByVendorId = new Map();
    for (const m of manufacturers || []) {
      if (m.qb_vendor_id) mfgByVendorId.set(m.qb_vendor_id, m);
    }

    // Query QB for open POs
    const query = `SELECT * FROM PurchaseOrder WHERE TxnDate > '2024-01-01' ORDERBY TxnDate DESC MAXRESULTS 50`;
    const qbRes = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${realm_id}/query?query=${encodeURIComponent(query)}&minorversion=73`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: 'application/json',
        },
      }
    );

    if (!qbRes.ok) {
      const errText = await qbRes.text();
      return new Response(JSON.stringify({ success: false, error: `QB API ${qbRes.status}: ${errText}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const qbData = await qbRes.json();
    const allPOs = qbData?.QueryResponse?.PurchaseOrder || [];

    // Filter: only Open POs with a real doc_number (skip test POs)
    const skipDocNumbers = new Set([null, undefined, '']);
    const skipContracts = new Set(['1111111', '890000', '900000']);

    const realPOs = allPOs.filter((po: any) => {
      if (po.POStatus !== 'Open') return false;
      const docNum = po.DocNumber;
      if (!docNum) return false; // skip POs with no doc number
      // Check memo for fake contract numbers
      const memo = po.Memo || po.PrivateNote || '';
      for (const fake of skipContracts) {
        if (memo.includes(fake)) return false;
      }
      return true;
    });

    // Check which PO doc numbers already exist as orders
    const { data: existingOrders } = await supabase
      .from('orders')
      .select('moly_contract_number, qb_po_doc_number');

    const existingContracts = new Set(
      (existingOrders || []).flatMap(o => [o.moly_contract_number, o.qb_po_doc_number].filter(Boolean))
    );

    const results: any[] = [];
    const errors: any[] = [];
    let imported = 0;
    let skipped = 0;

    for (const po of realPOs) {
      const docNumber = po.DocNumber;

      // Skip if already imported
      if (existingContracts.has(docNumber)) {
        skipped++;
        results.push({ doc_number: docNumber, action: 'skipped', reason: 'already exists' });
        continue;
      }

      const vendorId = po.VendorRef?.value;
      const vendorName = po.VendorRef?.name;
      const manufacturer = mfgByVendorId.get(vendorId);

      const lines = (po.Line || []).filter((l: any) => l.DetailType === 'ItemBasedExpenseLineDetail');
      if (lines.length === 0) {
        skipped++;
        results.push({ doc_number: docNumber, action: 'skipped', reason: 'no line items' });
        continue;
      }

      // Find the base model (first line that matches a base_model)
      let baseModel = null;
      let baseModelLine = null;
      const optionLines: any[] = [];
      let freightLine = null;

      for (const line of lines) {
        const itemId = line.ItemBasedExpenseLineDetail?.ItemRef?.value;
        const itemName = line.ItemBasedExpenseLineDetail?.ItemRef?.name || '';

        if (baseModelByQbId.has(itemId)) {
          if (!baseModel) {
            baseModel = baseModelByQbId.get(itemId);
            baseModelLine = line;
          } else {
            // Multiple base models? Treat extras as options
            optionLines.push(line);
          }
        } else if (itemName.toLowerCase().includes('freight')) {
          freightLine = line;
        } else {
          optionLines.push(line);
        }
      }

      // Build selected_options JSONB
      const selectedOptions: any[] = [];

      // Add base model
      if (baseModel && baseModelLine) {
        selectedOptions.push({
          option_id: baseModel.id,
          name: baseModel.name,
          qb_item_id: baseModel.qb_item_id,
          qb_item_name: baseModel.qb_item_name,
          cost_price_each: baseModelLine.ItemBasedExpenseLineDetail?.UnitPrice || baseModel.cost_price,
          retail_price_each: baseModel.retail_price,
          quantity: baseModelLine.ItemBasedExpenseLineDetail?.Qty || 1,
          is_base_model: true,
        });
      }

      // Add options
      for (const line of optionLines) {
        const itemId = line.ItemBasedExpenseLineDetail?.ItemRef?.value;
        const itemName = line.ItemBasedExpenseLineDetail?.ItemRef?.name || '';
        const matchedOption = optionByQbId.get(itemId);

        selectedOptions.push({
          option_id: matchedOption?.id || null,
          name: matchedOption?.name || itemName.split(':').pop()?.trim() || itemName,
          qb_item_id: itemId,
          qb_item_name: itemName,
          cost_price_each: line.ItemBasedExpenseLineDetail?.UnitPrice || 0,
          retail_price_each: matchedOption?.retail_price || null,
          quantity: line.ItemBasedExpenseLineDetail?.Qty || 1,
          is_base_model: false,
          category: matchedOption?.category || null,
          description: line.Description || null,
        });
      }

      // Calculate totals
      const ourCost = lines.reduce((sum: number, l: any) => sum + (l.Amount || 0), 0);
      const freightAmount = freightLine?.Amount || 0;

      // Calculate estimated retail from matched options
      let retailTotal = 0;
      for (const opt of selectedOptions) {
        const retail = opt.retail_price_each || opt.cost_price_each;
        retailTotal += retail * (opt.quantity || 1);
      }

      // Determine equipment type from base model name
      let equipmentType = 'chute';
      const firstItemName = (lines[0]?.ItemBasedExpenseLineDetail?.ItemRef?.name || '').toLowerCase();
      if (firstItemName.includes('alley')) equipmentType = 'alley';
      else if (firstItemName.includes('processor')) equipmentType = 'processor';
      else if (firstItemName.includes('gate')) equipmentType = 'gate';
      else if (firstItemName.includes('loading')) equipmentType = 'loading_chute';
      else if (firstItemName.includes('calf table')) equipmentType = 'calf_table';

      // Determine if Moly contract number (numeric 5-digit doc numbers are Moly contracts)
      const isMolyContract = /^\d{5}$/.test(docNumber);

      const orderRecord = {
        moly_contract_number: isMolyContract ? docNumber : null,
        contract_name: isMolyContract
          ? `${baseModel?.name || 'Equipment'} #${docNumber}`
          : `${vendorName} - ${docNumber}`,
        manufacturer_id: manufacturer?.id || null,
        base_model_id: baseModel?.id || null,
        base_model: baseModel?.name || lines[0]?.ItemBasedExpenseLineDetail?.ItemRef?.name?.split(':').pop()?.trim() || 'Unknown',
        selected_options: selectedOptions,
        our_cost: ourCost,
        customer_price: retailTotal,
        subtotal: ourCost,
        freight_estimate: freightAmount,
        from_inventory: true,
        status: 'order_pending',
        ordered_date: po.TxnDate,
        equipment_type: equipmentType,
        source_type: 'direct_order',
        qb_po_id: po.Id,
        qb_po_doc_number: docNumber,
        notes: po.Memo || po.PrivateNote || null,
      };

      if (dryRun) {
        results.push({
          doc_number: docNumber,
          action: 'would_import',
          vendor: vendorName,
          base_model: baseModel?.name || 'no match',
          our_cost: ourCost,
          retail_estimate: retailTotal,
          option_count: selectedOptions.length - 1,
          contract_name: orderRecord.contract_name,
        });
      } else {
        const { data: inserted, error: insertErr } = await supabase
          .from('orders')
          .insert(orderRecord)
          .select('id')
          .single();

        if (insertErr) {
          errors.push({ doc_number: docNumber, error: insertErr.message });
        } else {
          imported++;
          results.push({
            doc_number: docNumber,
            action: 'imported',
            order_id: inserted.id,
            vendor: vendorName,
            base_model: baseModel?.name || 'no match',
            our_cost: ourCost,
          });

          // Add timeline entry
          await supabase.from('order_timeline').insert({
            order_id: inserted.id,
            event_type: 'order_created',
            title: 'Order imported from QuickBooks PO',
            description: `Imported from QB PO #${docNumber}. Cost: $${ourCost.toLocaleString()}`,
            created_by: 'system',
          });
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      dry_run: dryRun,
      total_open_pos: realPOs.length,
      imported,
      skipped,
      errors: errors.length,
      results,
      error_details: errors,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
