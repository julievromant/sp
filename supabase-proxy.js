import { createClient } from '@supabase/supabase-js';

export async function onRequestPost(context) {
    const { request, env } = context;

    // Vérification initiale des variables d'environnement Supabase
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return new Response(JSON.stringify({ 
            status: 'error', 
            message: 'Configuration serveur incomplète : SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant dans les variables d’environnement Cloudflare Pages.' 
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const body = await request.json().catch(() => ({}));
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
                    console.error("Erreur Supabase signInWithOtp détaillée:", JSON.stringify(error, null, 2));
                    throw new Error(error.message + (error.status ? ` (Status: ${error.status})` : ''));
                }
                result = { status: 'success', message: 'Lien magique envoyé avec succès.' };
                break;
            }

            case 'verify_magic_link': {
                const code = payload.code;
                const hash = payload.hash;

                if (!code && (!hash || !hash.includes('access_token'))) {
                    throw new Error("Paramètres d'authentification manquants (ni code PKCE ni token hash trouvés).");
                }

                let authUser = null;

                if (code) {
                    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
                    if (sessionError || !sessionData || !sessionData.user) {
                        console.error("Erreur exchangeCodeForSession détaillée:", JSON.stringify(sessionError, null, 2));
                        throw new Error(sessionError?.message || "Échec de l'échange du code PKCE contre une session.");
                    }
                    authUser = sessionData.user;
                } else if (hash) {
                    const params = new URLSearchParams(hash.replace(/^#/, ''));
                    const accessToken = params.get('access_token');
                    if (accessToken) {
                        const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
                        if (!userErr && userData) authUser = userData.user;
                    }
                }

                if (!authUser) {
                    throw new Error("Impossible d'identifier l'utilisateur authentifié depuis Supabase Auth.");
                }

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
        console.error("ERREUR CRITIQUE DANS PROXY (500):", error.stack || error.message);
        return new Response(JSON.stringify({ 
            status: 'error', 
            message: error.message || 'Erreur interne du serveur',
            stack: error.stack 
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}