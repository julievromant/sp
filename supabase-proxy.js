import { createClient } from '@supabase/supabase-js';

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const body = await request.json();
        const { action, ...payload } = body;
        let result = { status: 'success' };

        const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

        switch (action) {
            case 'get_data': {
                const { data: events, error: evErr } = await supabase.from('events').select('*');
                if (evErr) console.error("Erreur lecture events:", evErr);
                const { data: users, error: usErr } = await supabase.from('users').select('*');
                if (usErr) console.error("Erreur lecture users:", usErr);
                result = { events: events || [], users: users || [] };
                break;
            }

            case 'save_event': {
                const { error } = await supabase.from('events').upsert(payload.event);
                if (error) throw new Error("Erreur save_event: " + error.message);
                break;
            }

            case 'delete_event': {
                const { error } = await supabase.from('events').delete().eq('id', payload.eventId);
                if (error) throw new Error("Erreur delete_event: " + error.message);
                break;
            }

            case 'check_email': {
                const email = (payload.email || '').trim().toLowerCase();
                const { data, error } = await supabase.from('users').select('email').eq('email', email).maybeSingle();
                if (error) console.error("Erreur check_email:", error);
                result = { exists: !!data };
                break;
            }

            case 'send_magic_link': {
                const email = (payload.email || '').trim().toLowerCase();
                const firstname = payload.firstname || 'Parent';
                const lastname = payload.lastname || 'Bénévole';
                const kidsClasses = payload.kidsClasses || 'CP';

                if (payload.isNew) {
                    await supabase.from('users').upsert({
                        email: email,
                        firstname: firstname,
                        lastname: lastname,
                        kids_classes: kidsClasses,
                        is_admin: email === 'marie.parent@apel.fr'
                    }, { onConflict: 'email' });
                }

                const redirectUrl = new URL(request.url).origin + '/';
                const { data, error } = await supabase.auth.signInWithOtp({
                    email: email,
                    options: {
                        emailRedirectTo: redirectUrl,
                        data: {
                            firstname: firstname,
                            lastname: lastname,
                            kids_classes: kidsClasses
                        }
                    }
                });

                if (error) {
                    console.error("Erreur Supabase signInWithOtp:", error);
                    throw new Error(error.message);
                }
                result = { status: 'success', message: 'Lien magique envoyé avec succès.' };
                break;
            }

            case 'verify_magic_link': {
                const code = payload.code;
                if (!code) throw new Error("Code d'authentification manquant dans la requête.");

                const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
                if (sessionError || !sessionData || !sessionData.user) {
                    console.error("Erreur exchangeCodeForSession:", sessionError);
                    throw new Error(sessionError?.message || "Impossible d'échanger le code contre une session Supabase.");
                }

                const authUser = sessionData.user;
                const email = authUser.email.toLowerCase();
                const metadata = authUser.user_metadata || {};

                let { data: dbUser, error: findErr } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
                if (findErr) console.error("Erreur recherche user dans public.users:", findErr);

                if (!dbUser) {
                    const newUser = {
                        id: authUser.id,
                        email: email,
                        firstname: metadata.firstname || 'Parent',
                        lastname: metadata.lastname || 'Bénévole',
                        kids_classes: metadata.kids_classes || 'CP',
                        is_admin: email === 'marie.parent@apel.fr'
                    };
                    const { data: inserted, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
                    if (insertErr) {
                        console.error("Erreur insertion public.users:", insertErr);
                        throw new Error("Erreur base de données lors de la création de l'utilisateur: " + insertErr.message);
                    }
                    dbUser = inserted;
                }

                result = { status: 'success', user: dbUser };
                break;
            }

            default:
                throw new Error('Action inconnue ou non gérée: ' + action);
        }

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error("ERREUR CRITIQUE DANS PROXY (500):", error.message);
        return new Response(JSON.stringify({ status: 'error', message: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}